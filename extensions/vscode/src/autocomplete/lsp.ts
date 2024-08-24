import type { IDE, RangeInFile } from "core";
import { getAst, getTreePathAtCursor } from "core/autocomplete/ast";
import { GetLspDefinitionsFunction } from "core/autocomplete/completionProvider";
import { AutocompleteLanguageInfo } from "core/autocomplete/languages";
import { AutocompleteSnippet } from "core/autocomplete/ranking";
import { RangeInFileWithContents } from "core/commands/util";
import {
  FUNCTION_BLOCK_NODE_TYPES,
  FUNCTION_DECLARATION_NODE_TYPEs,
} from "core/indexing/chunk/code";
import { intersection } from "core/util/ranges";
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
function gotoInputKey(input: GotoInput) {
  return `${input.name}${input.uri.toString}${input.line}${input.character}`;
}

const MAX_CACHE_SIZE = 50;
const gotoCache = new Map<string, RangeInFile[]>();

export async function executeGotoProvider(
  input: GotoInput,
): Promise<RangeInFile[]> {
  const cacheKey = gotoInputKey(input);
  const cached = gotoCache.get(cacheKey);
  if (cached) {
    console.log(`LSP: Using cached result for ${input.name}`);
    return cached;
  }

  try {
    const definitions = (await vscode.commands.executeCommand(
      input.name,
      vscode.Uri.parse(input.uri),
      new vscode.Position(input.line, input.character),
    )) as any;

    const results = definitions
      .filter((d: any) => (d.targetUri || d.uri) && (d.targetRange || d.range))
      .map((d: any) => ({
        filepath: (d.targetUri || d.uri).fsPath,
        range: d.targetRange || d.range,
      }));

    console.log(`LSP: ${input.name} returned ${results.length} results`);

    // Add to cache
    if (gotoCache.size >= MAX_CACHE_SIZE) {
      // Remove the oldest item from the cache
      const oldestKey = gotoCache.keys().next().value;
      gotoCache.delete(oldestKey);
    }
    gotoCache.set(cacheKey, results);

    return results;
  } catch (e) {
    console.warn(`Error executing ${name}:`, e);
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

async function crawlTypes(
  rif: RangeInFile | RangeInFileWithContents,
  ide: IDE,
  depth: number = 1,
  results: RangeInFileWithContents[] = [],
  searchedLabels: Set<string> = new Set(),
): Promise<RangeInFileWithContents[]> {
  console.log(`LSP: Crawling types for ${rif.filepath}`);

  // Get the file contents if not already attached
  const contents = isRifWithContents(rif)
    ? rif.contents
    : await ide.readFile(rif.filepath);

  console.log(`LSP: File contents fetched for ${rif.filepath}`);

  // Parse AST
  const ast = await getAst(rif.filepath, contents);
  if (!ast) return results;
  const astLineCount = ast.rootNode.text.split("\n").length;

  // Find type identifiers
  const identifierNodes = findTypeIdentifiers(ast.rootNode).filter(
    (node) => !searchedLabels.has(node.text),
  );
  // Don't search for the same type definition more than once
  // We deduplicate below to be sure, but this saves calls to the LSP
  identifierNodes.forEach((node) => searchedLabels.add(node.text));

  console.log(`LSP: Found ${identifierNodes.length} type identifiers`);

  // Use LSP to get the definitions of those types
  const definitions = await Promise.all(
    identifierNodes.map(async (node) => {
      console.log(`LSP: Getting definition for ${node.text}`);
      const [typeDef] = await executeGotoProvider({
        uri: rif.filepath,
        // TODO: tree-sitter is zero-indexed, but there seems to be an off-by-one
        // error at least with the .ts parser sometimes
        line:
          rif.range.start.line +
          Math.min(node.startPosition.row, astLineCount - 1),
        character: rif.range.start.character + node.startPosition.column,
        name: "vscode.executeDefinitionProvider",
      });

      if (!typeDef) {
        console.log(`LSP: No definition found for ${node.text}`);
        return undefined;
      }
      console.log(`LSP: Definition found for ${node.text}`);
      console.log(`LSP: Definition contents fetched for ${node.text}`);
      return {
        ...typeDef,
        contents: await ide.readRangeInFile(typeDef.filepath, typeDef.range),
      };
    }),
  );

  // Filter out duplicates
  for (const definition of definitions) {
    if (
      !definition ||
      results.some(
        (result) =>
          result.filepath === definition.filepath &&
          intersection(result.range, definition.range) !== null,
      )
    ) {
      continue; // ;)
    }
    results.push(definition);
  }

  console.log(`LSP: Added ${results.length} unique definitions`);

  // Recurse
  if (depth > 0) {
    for (const result of [...results]) {
      await crawlTypes(result, ide, depth - 1, results, searchedLabels);
    }
  }

  return results;
}

async function getFunctionInfo(
  uri: string,
  position: vscode.Position
): Promise<string> {
  const hoverResult = await vscode.commands.executeCommand(
    'vscode.executeHoverProvider',
    vscode.Uri.parse(uri),
    position
  ) as vscode.Hover[];

  if (hoverResult && hoverResult.length > 0) {
    const hoverContent = hoverResult[0].contents[0];
    if (typeof hoverContent === 'object' && 'value' in hoverContent) {
      return hoverContent.value.trim();
    }
  }

  return '';
}

function isRangeInFile(obj: any): obj is RangeInFile {
  return obj && typeof obj.filepath === 'string' && obj.range && typeof obj.range === 'object';
}

function isRangeInFileWithContents(obj: any): obj is RangeInFileWithContents {
  return isRangeInFile(obj) && 'contents' in obj && typeof obj.contents === 'string';
}

export async function getDefinitionsForNode(
  uri: string,
  node: Parser.SyntaxNode,
  ide: IDE,
  lang: AutocompleteLanguageInfo,
  cursorPosition: vscode.Position
): Promise<RangeInFileWithContents[]> {
  console.log(`LSP: Getting definitions for node type ${node.type}`);
  const ranges: RangeInFileWithContents[] = [];

  const MAX_DISTANCE = 5; // Maximum number of lines to consider

  switch (node.type) {
    case "call_expression":
    case "call":
      {
        const nodePosition = new vscode.Position(node.startPosition.row, node.startPosition.column);
        const distance = Math.abs(nodePosition.line - cursorPosition.line);

        if (distance <= MAX_DISTANCE) {
          console.log(`LSP: Getting function info for nearby call expression`);
          const hoverInfo = await getFunctionInfo(uri, nodePosition);

          if (hoverInfo) {
            const range = {
              start: { line: node.startPosition.row, character: node.startPosition.column },
              end: { line: node.endPosition.row, character: node.endPosition.column }
            };

            ranges.push({
              filepath: uri,
              range: range,
              contents: hoverInfo,
            });
          }
        }
      }
      break;

    // ... other cases can be added here if needed ...

    default:
      console.log(`LSP: Unhandled node type: ${node.type}`);
      break;
  }

  return ranges;
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
      ast.rootNode.text.slice(0, cursorIndex).split('\n').length - 1,
      cursorIndex - ast.rootNode.text.lastIndexOf('\n', cursorIndex - 1) - 1
    );

    const results: RangeInFileWithContents[] = [];
    for (const node of treePath.reverse()) {
      console.log(`LSP: Processing node of type ${node.type}`);
      const definitions = await getDefinitionsForNode(
        filepath,
        node,
        ide,
        lang,
        cursorPosition
      );
      results.push(...definitions);
    }

    console.log(`LSP: Returning ${results.length} definitions`);
    return results.map((result) => ({
      ...result,
      score: 0.8,
    }));
  } catch (e) {
    console.warn("Error getting definitions from LSP: ", e);
    return [];
  }
};