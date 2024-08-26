import type { IDE, RangeInFile } from "core";
import { getAst, getTreePathAtCursor } from "core/autocomplete/ast";
import { GetLspDefinitionsFunction } from "core/autocomplete/completionProvider";
import { AutocompleteLanguageInfo } from "core/autocomplete/languages";
import { AutocompleteSnippet } from "core/autocomplete/ranking";
import { RangeInFileWithContents } from "core/commands/util";
import * as vscode from "vscode";
import type Parser from "web-tree-sitter";

type GotoProviderName =
  | "vscode.executeDefinitionProvider"
  | "vscode.executeTypeDefinitionProvider"
  | "vscode.executeDeclarationProvider"
  | "vscode.executeImplementationProvider"
  | "vscode.executeReferenceProvider";

interface GotoInput {
  uri: string;
  line: number;
  character: number;
  name: GotoProviderName;
}

const MAX_CACHE_SIZE = 50;
const gotoCache = new Map<string, RangeInFile[]>();

export async function executeGotoProvider(input: GotoInput): Promise<RangeInFile[]> {
  const cacheKey = `${input.name}${input.uri}${input.line}${input.character}`;
  const cached = gotoCache.get(cacheKey);
  if (cached) {
    console.log(`LSP: Using cached result for ${input.name}`);
    return cached;
  }

  try {
    const definitions = await vscode.commands.executeCommand(
      input.name,
      vscode.Uri.parse(input.uri),
      new vscode.Position(input.line, input.character)
    ) as any[];

    const results = definitions
      .filter(d => (d.targetUri || d.uri) && (d.targetRange || d.range))
      .map(d => ({
        filepath: (d.targetUri || d.uri).fsPath,
        range: d.targetRange || d.range,
      }));

    console.log(`LSP: ${input.name} returned ${results.length} results`);

    if (gotoCache.size >= MAX_CACHE_SIZE) {
      gotoCache.delete(gotoCache.keys().next().value);
    }
    gotoCache.set(cacheKey, results);

    return results;
  } catch (e) {
    console.warn(`Error executing ${input.name}:`, e);
    return [];
  }
}

function isRifWithContents(
  rif: RangeInFile | RangeInFileWithContents,
): rif is RangeInFileWithContents {
  return typeof (rif as any).contents === "string";
}

function findChildren(
  node: Parser.SyntaxNode,
  predicate: (n: Parser.SyntaxNode) => boolean,
  firstN?: number,
): Parser.SyntaxNode[] {
  let matchingNodes: Parser.SyntaxNode[] = [];

  if (firstN && firstN <= 0) {
    return [];
  }

  // Check if the current node's type is in the list of types we're interested in
  if (predicate(node)) {
    matchingNodes.push(node);
  }

  // Recursively search for matching types in all children of the current node
  for (const child of node.children) {
    matchingNodes = matchingNodes.concat(
      findChildren(
        child,
        predicate,
        firstN ? firstN - matchingNodes.length : undefined,
      ),
    );
  }

  return matchingNodes;
}

function findTypeIdentifiers(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return findChildren(
    node,
    (childNode) =>
      childNode.type === "type_identifier" ||
      (["ERROR"].includes(childNode.parent?.type ?? "") &&
        childNode.type === "identifier" &&
        childNode.text[0].toUpperCase() === childNode.text[0]),
  );
}

async function getFunctionInfo(uri: string, position: vscode.Position): Promise<string> {
  const hoverResult = await vscode.commands.executeCommand(
    'vscode.executeHoverProvider',
    vscode.Uri.parse(uri),
    position
  ) as vscode.Hover[];

  if (hoverResult?.[0]?.contents[0] && typeof hoverResult[0].contents[0] === 'object' && 'value' in hoverResult[0].contents[0]) {
    return hoverResult[0].contents[0].value.trim();
  }

  return '';
}

async function getDefinitionsForNode(
  uri: string,
  node: Parser.SyntaxNode,
  cursorPosition: vscode.Position
): Promise<RangeInFileWithContents[]> {
  console.log(`LSP: Getting definitions for node type ${node.type}`);
  const MAX_DISTANCE = 5;

  if (node.type === "call_expression" || node.type === "call") {
    const nameNode = node.childForFieldName('method') ||
      (node.childForFieldName('function')?.lastNamedChild ||
        node.childForFieldName('function'));

    if (nameNode) {
      const nodePosition = new vscode.Position(nameNode.startPosition.row, nameNode.startPosition.column);
      if (Math.abs(nodePosition.line - cursorPosition.line) <= MAX_DISTANCE) {
        const hoverInfo = await getFunctionInfo(uri, nodePosition);
        if (hoverInfo) {
          return [{
            filepath: uri,
            range: {
              start: { line: nameNode.startPosition.row, character: nameNode.startPosition.column },
              end: { line: nameNode.endPosition.row, character: nameNode.endPosition.column }
            },
            contents: hoverInfo,
          }];
        }
      }
    }
  }

  return [];
}

export const getDefinitionsFromLsp: GetLspDefinitionsFunction = async (
  filepath: string,
  contents: string,
  cursorIndex: number,
  ide: IDE,
  lang: AutocompleteLanguageInfo,
): Promise<AutocompleteSnippet[]> => {
  try {
    console.log(`LSP: Getting definitions for ${filepath}`);
    const ast = await getAst(filepath, contents);
    if (!ast) return [];

    const treePath = await getTreePathAtCursor(ast, cursorIndex);
    if (!treePath) return [];

    console.log(`LSP: Found ${treePath.length} nodes in tree path`);

    const cursorPosition = new vscode.Position(
      contents.slice(0, cursorIndex).split('\n').length - 1,
      cursorIndex - contents.lastIndexOf('\n', cursorIndex - 1) - 1
    );

    const results = await Promise.all(
      treePath.reverse().map(node => getDefinitionsForNode(filepath, node, cursorPosition))
    );

    const flatResults = results.flat();
    console.log(`LSP: Returning ${flatResults.length} definitions`);

    return flatResults.map(result => ({
      ...result,
      score: 0.8,
    }));
  } catch (e) {
    console.warn("Error getting definitions from LSP: ", e);
    return [];
  }
};