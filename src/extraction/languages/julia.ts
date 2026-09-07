/**
 * Julia language extractor.
 *
 * Based on https://github.com/colbymchenry/codegraph/pull/244 (@kongdd), with
 * vendored WASM load plus Polaris-oriented support for short definitions,
 * declaration macros, modules, constants, enums, and flat function bodies.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

const JULIA_SIGNATURE_WRAPPERS = new Set([
  'signature',
  'typed_expression',
  'where_expression',
]);

const JULIA_MACRO_DECLARATION_TYPES = new Set([
  'abstract_definition',
  'const_statement',
  'function_definition',
  'import_statement',
  'macro_definition',
  'module_definition',
  'struct_definition',
  'using_statement',
]);

function unwrapJuliaHead(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (JULIA_SIGNATURE_WRAPPERS.has(current.type)) {
    const inner = current.namedChild(0);
    if (!inner) break;
    current = inner;
  }
  return current;
}

function findJuliaCall(node: SyntaxNode): SyntaxNode | null {
  const head = unwrapJuliaHead(node);
  return head.type === 'call_expression' ? head : null;
}

function extractFunctionName(signatureNode: SyntaxNode, source: string): string | null {
  const head = unwrapJuliaHead(signatureNode);
  if (head.type === 'identifier') {
    return getNodeText(head, source);
  }
  if (head.type === 'call_expression') {
    const first = head.namedChild(0);
    if (!first) return null;
    if (first.type === 'identifier') {
      return getNodeText(first, source);
    }
    if (first.type === 'field_expression') {
      const ids = first.namedChildren.filter((c) => c.type === 'identifier');
      if (ids.length > 0) {
        return getNodeText(ids[ids.length - 1]!, source);
      }
    }
    return getNodeText(first, source);
  }
  return getNodeText(head, source);
}

function extractFunctionSignature(signatureNode: SyntaxNode, source: string): string | undefined {
  const call = findJuliaCall(signatureNode);
  if (!call) return undefined;
  const args = call.namedChildren.find((child) => child.type === 'argument_list');
  if (!args) return undefined;
  return source.substring(args.startIndex, signatureNode.endIndex).trim() || undefined;
}

function extractTypeName(typeHeadNode: SyntaxNode, source: string): string | null {
  if (typeHeadNode.type === 'identifier') {
    return getNodeText(typeHeadNode, source);
  }
  if (typeHeadNode.type === 'call_expression' || typeHeadNode.type === 'parametrized_type_expression') {
    const first = typeHeadNode.namedChild(0);
    if (first) return getNodeText(first, source);
  }
  if (typeHeadNode.type === 'binary_expression') {
    const first = typeHeadNode.namedChild(0);
    if (first) return extractTypeName(first, source);
  }
  if (typeHeadNode.type === 'where_expression') {
    const expr = typeHeadNode.namedChild(0);
    if (expr) return extractTypeName(expr, source);
  }
  return getNodeText(typeHeadNode, source);
}

function juliaAssignmentFnName(node: SyntaxNode, source: string): string | null {
  const left = node.namedChild(0);
  if (!left || !findJuliaCall(left)) return null;
  return extractFunctionName(left, source);
}

function juliaDefinitionSignatureNode(node: SyntaxNode): SyntaxNode | null {
  if (node.type !== 'function_definition' && node.type !== 'macro_definition') {
    return null;
  }
  return node.namedChild(0);
}

function resolveJuliaBodyNodes(node: SyntaxNode): SyntaxNode[] | null {
  const signature = juliaDefinitionSignatureNode(node);
  if (!signature) return null;
  if (node.namedChildren.some((child) => child.type === 'block')) return null;

  const bodyNodes: SyntaxNode[] = [];
  for (let i = 1; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) bodyNodes.push(child);
  }
  return bodyNodes;
}

function visitJuliaShortFunction(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const source = ctx.source;
  const name = juliaAssignmentFnName(node, source);
  if (!name) return false;

  const left = node.namedChild(0);
  if (!left) return false;
  const fn = ctx.createNode('function', name, node, {
    signature: extractFunctionSignature(left, source),
  });
  if (!fn) return true;

  ctx.pushScope(fn.id);
  for (let i = 1; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type !== 'operator') {
      ctx.visitFunctionBody(child, fn.id);
    }
  }
  ctx.popScope();
  return true;
}

function juliaConstName(node: SyntaxNode, source: string): string | null {
  const declaration = node.namedChildren.find((child) => child.type === 'assignment')
    ?? node.namedChild(0);
  if (!declaration) return null;
  const left = declaration.type === 'assignment'
    ? declaration.namedChild(0)
    : declaration;
  if (!left) return null;
  const head = unwrapJuliaHead(left);
  return head.type === 'identifier' ? getNodeText(head, source) : null;
}

function visitJuliaConst(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = juliaConstName(node, ctx.source);
  if (!name) return true;

  const constant = ctx.createNode('constant', name, node, {
    signature: getNodeText(node, ctx.source).trim().slice(0, 200),
  });
  const assignment = node.namedChildren.find((child) => child.type === 'assignment');
  if (!constant || !assignment) return true;

  ctx.pushScope(constant.id);
  for (let i = 1; i < assignment.namedChildCount; i++) {
    const child = assignment.namedChild(i);
    if (child && child.type !== 'operator') {
      ctx.visitFunctionBody(child, constant.id);
    }
  }
  ctx.popScope();
  return true;
}

function juliaImportName(part: SyntaxNode, source: string): string | null {
  if (
    part.type === 'identifier' ||
    part.type === 'field_expression' ||
    part.type === 'import_path'
  ) {
    return getNodeText(part, source);
  }
  if (part.type === 'selected_import' || part.type === 'import_alias') {
    const path = part.namedChild(0);
    return path ? juliaImportName(path, source) ?? getNodeText(path, source) : null;
  }
  return null;
}

function visitJuliaImport(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const signature = getNodeText(node, ctx.source).trim();
  const imports: Array<{ name: string; node: SyntaxNode }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const name = juliaImportName(child, ctx.source);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    imports.push({ name, node: child });
  }

  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  for (const imported of imports) {
    ctx.createNode('import', imported.name, imported.node, { signature });
    if (parentId) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: imported.name,
        referenceKind: 'imports',
        line: imported.node.startPosition.row + 1,
        column: imported.node.startPosition.column,
      });
    }
  }
  return true;
}

function juliaMacroName(node: SyntaxNode, source: string): string | null {
  const macro = node.namedChildren.find((child) => child.type === 'macro_identifier');
  return macro ? getNodeText(macro, source).replace(/^@/, '') : null;
}

function containsJuliaDeclaration(node: SyntaxNode, source: string): boolean {
  if (JULIA_MACRO_DECLARATION_TYPES.has(node.type)) return true;
  if (node.type === 'assignment' && juliaAssignmentFnName(node, source)) return true;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && containsJuliaDeclaration(child, source)) return true;
  }
  return false;
}

function juliaEnumMemberName(node: SyntaxNode, source: string): string | null {
  if (node.type === 'identifier') return getNodeText(node, source);
  if (node.type === 'assignment') {
    const left = node.namedChild(0);
    if (!left) return null;
    const head = unwrapJuliaHead(left);
    return head.type === 'identifier' ? getNodeText(head, source) : null;
  }
  return null;
}

function visitJuliaEnum(node: SyntaxNode, args: SyntaxNode, ctx: ExtractorContext): boolean {
  const head = args.namedChild(0);
  if (!head) return true;
  const enumHead = unwrapJuliaHead(head);
  if (enumHead.type !== 'identifier') return true;

  const enumNode = ctx.createNode('enum', getNodeText(enumHead, ctx.source), node, {
    signature: getNodeText(node, ctx.source).trim().slice(0, 200),
  });
  if (!enumNode) return true;

  const visitMembers = (memberRoot: SyntaxNode): void => {
    const memberName = juliaEnumMemberName(memberRoot, ctx.source);
    if (memberName) {
      ctx.createNode('enum_member', memberName, memberRoot);
      return;
    }
    for (let i = 0; i < memberRoot.namedChildCount; i++) {
      const child = memberRoot.namedChild(i);
      if (child) visitMembers(child);
    }
  };

  ctx.pushScope(enumNode.id);
  for (let i = 1; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (child) visitMembers(child);
  }
  ctx.popScope();
  return true;
}

function visitJuliaMacroDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = node.namedChildren.find((child) => child.type === 'macro_argument_list');
  if (!args) return false;

  const macroName = juliaMacroName(node, ctx.source);
  if (macroName === 'enum') return visitJuliaEnum(node, args, ctx);
  if (!containsJuliaDeclaration(args, ctx.source)) return false;

  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (child) ctx.visitNode(child);
  }
  return true;
}

function visitJuliaStructField(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.parent?.type !== 'struct_definition') return false;

  if (node.type === 'identifier') {
    ctx.createNode('field', getNodeText(node, ctx.source), node);
    return true;
  }
  if (node.type !== 'typed_expression') return false;

  const nameNode = node.namedChild(0);
  if (!nameNode || nameNode.type !== 'identifier') return false;
  ctx.createNode('field', getNodeText(nameNode, ctx.source), node, {
    signature: getNodeText(node, ctx.source),
  });
  return true;
}

function visitJuliaNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (visitJuliaStructField(node, ctx)) return true;

  if (node.type === 'assignment') {
    return visitJuliaShortFunction(node, ctx);
  }
  if (node.type === 'const_statement') {
    return visitJuliaConst(node, ctx);
  }
  if (node.type === 'using_statement' || node.type === 'import_statement') {
    return visitJuliaImport(node, ctx);
  }
  if (node.type === 'macrocall_expression') {
    return visitJuliaMacroDeclaration(node, ctx);
  }
  if (node.type === 'module_definition') {
    const name = juliaExtractor.resolveName?.(node, ctx.source) ?? '';
    const mod = ctx.createNode('module', name || 'anonymous', node);
    if (mod) ctx.pushScope(mod.id);
    const nameNode = node.childForFieldName('name');
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child !== nameNode) ctx.visitNode(child);
    }
    if (mod) ctx.popScope();
    return true;
  }
  return false;
}

export const juliaExtractor: LanguageExtractor = {
  functionTypes: ['function_definition', 'macro_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: ['abstract_definition'],
  structTypes: ['struct_definition'],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement', 'using_statement'],
  callTypes: ['call_expression', 'macrocall_expression'],
  variableTypes: ['const_statement'],
  interfaceKind: 'interface',

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'signature',

  resolveName: (node, source) => {
    if (node.type === 'function_definition' || node.type === 'macro_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child || child.type === 'block') continue;
        return extractFunctionName(child, source) ?? undefined;
      }
      return undefined;
    }

    if (node.type === 'struct_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child || child.type === 'block') continue;
        return extractTypeName(child, source) ?? undefined;
      }
      return undefined;
    }

    if (node.type === 'abstract_definition') {
      const typeHead = node.namedChild(0);
      if (typeHead) return extractTypeName(typeHead, source) ?? undefined;
      return undefined;
    }

    if (node.type === 'module_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) return getNodeText(nameNode, source);
      return undefined;
    }

    return undefined;
  },

  getSignature: (node, source) => {
    if (node.type === 'function_definition' || node.type === 'macro_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child || child.type === 'block') continue;
        return extractFunctionSignature(child, source);
      }
    }
    return undefined;
  },

  isAsync: () => false,

  resolveBodyNodes: resolveJuliaBodyNodes,

  resolveBody: (node, _bodyField) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'block') return child;
    }
    // Structs without a block wrapper: fields are direct children (handled by extractStruct).
    if (node.type === 'struct_definition') {
      return node;
    }
    return null;
  },

  visitNode: visitJuliaNode,
  visitFunctionBodyNode: visitJuliaNode,
};
