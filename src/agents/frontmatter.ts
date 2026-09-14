/**
 * Minimal YAML-subset frontmatter parser.
 *
 * Deliberately dependency-free: agent definitions are simple `key: value` files
 * plus block scalars and lists. Supports:
 *   - `key: value`, single/double quoted scalars
 *   - block scalars `|` / `|-` (literal) and `>` / `>-` (folded)
 *   - nested indented blocks (returned with indentation stripped)
 *   - block lists (`- item`) and comma-separated lists
 *   - CRLF input
 *
 * It does NOT implement full YAML (no anchors, no flow maps, no multi-doc).
 * That is intentional: a bad agent file must never take down discovery.
 */

export interface ParsedFrontmatter {
	frontmatter: Record<string, string>;
	body: string;
}

/**
 * Fold a YAML folded block (`>`): single newlines become spaces, blank lines
 * become newlines, and more-indented lines keep their line breaks.
 */
function foldBlock(block: string): string {
	let folded = "";
	let hasContent = false;
	let previousMoreIndented = false;
	let blankLines = 0;

	for (const line of block.split("\n")) {
		const current = line.trimEnd();
		if (current.trim() === "") {
			if (hasContent) blankLines += 1;
			continue;
		}

		const currentMoreIndented = current.length > current.trimStart().length;
		if (hasContent) {
			if (blankLines > 0) {
				folded += "\n".repeat(
					blankLines + (previousMoreIndented || currentMoreIndented ? 1 : 0),
				);
			} else {
				folded += previousMoreIndented || currentMoreIndented ? "\n" : " ";
			}
		}
		folded += current;
		hasContent = true;
		previousMoreIndented = currentMoreIndented;
		blankLines = 0;
	}

	return folded.trim();
}

/**
 * Normalize a list value from either comma-separated or block-list syntax.
 * Only a leading `- ` marker is removed, so hyphenated values survive intact.
 */
export function parseFrontmatterList(
	raw: string | undefined,
): string[] | undefined {
	if (raw === undefined) return undefined;
	const items = raw
		.split("\n")
		.flatMap((line) => {
			const value = line.trim();
			const listItem = value.match(/^-\s+(.+)$/);
			return (listItem?.[1] ?? value).split(",");
		})
		.map((v) => v.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

export function stripQuotes(raw: string): string {
	if (raw.length >= 2) {
		const first = raw[0];
		const last = raw.at(-1);
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return raw.slice(1, -1);
		}
	}
	return raw;
}

/**
 * Parse a document into frontmatter + body.
 * A document without a leading `---` fence yields empty frontmatter.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
	const normalized = content.replace(/\r\n/g, "\n");
	const block = extractFrontmatterBlock(normalized);
	if (block === null) return { frontmatter: {}, body: normalized };

	return {
		frontmatter: parseFrontmatterLines(block.value),
		body: block.rest,
	};
}

/** The `---`-delimited block and everything after it, or null when absent. */
function extractFrontmatterBlock(
	normalized: string,
): { value: string; rest: string } | null {
	if (!normalized.startsWith("---")) return null;
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return null;
	return {
		value: normalized.slice(4, endIndex),
		rest: normalized.slice(endIndex + 4).trim(),
	};
}

/** The block scalars that introduce a multi-line value. */
const BLOCK_SCALARS = new Set(["|", "|-", "|+", ">", ">-", ">+"]);

/**
 * Parse the frontmatter block into `key -> raw text`.
 *
 * Values are kept as strings: nested blocks keep their relative indentation so
 * a caller (e.g. `parseAcceptance`) can interpret them. Block scalars (`|`, `>`)
 * are folded; quoted scalars are unquoted.
 */
function parseFrontmatterLines(block: string): Record<string, string> {
	const frontmatter: Record<string, string> = {};
	const open: OpenValue = { key: null, lines: null, indent: null, folded: false };

	for (const line of block.split("\n")) {
		const indent = line.search(/\S|$/);
		const trimmed = line.trim();

		// A deeper-indented line (or a blank line inside a folded block)
		// continues the value currently being collected.
		if (
			open.key !== null &&
			open.lines !== null &&
			(indent > (open.indent ?? 0) || (open.folded && trimmed === ""))
		) {
			open.lines.push(line);
			continue;
		}

		flushOpenValue(frontmatter, open);

		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue; // comments, blank lines, stray text

		const key = match[1] as string;
		const rawValue = (match[2] ?? "").trim();
		const quoted = isQuoted(rawValue);

		if (!quoted && BLOCK_SCALARS.has(rawValue)) {
			startOpenValue(open, key, indent, rawValue.startsWith(">"));
			continue;
		}

		if (rawValue === "") {
			// Either a nested block or an empty value; the next indented line
			// decides which. Collected either way, then stripped on flush.
			startOpenValue(open, key, indent, false);
			continue;
		}

		frontmatter[key] = stripQuotes(rawValue);
	}

	flushOpenValue(frontmatter, open);
	return frontmatter;
}

/** The value currently being collected across several lines. */
interface OpenValue {
	key: string | null;
	lines: string[] | null;
	indent: number | null;
	folded: boolean;
}

function startOpenValue(
	open: OpenValue,
	key: string,
	indent: number,
	folded: boolean,
): void {
	open.key = key;
	open.lines = [];
	open.indent = indent;
	open.folded = folded;
}

/**
 * Remove one leading indentation prefix from every line, then a leading blank.
 * A line without the prefix (shorter, or differently indented) is left alone so
 * relative indentation inside a nested block survives.
 */
function stripIndent(block: string, prefix: string): string {
	return block
		.split("\n")
		.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
		.join("\n")
		.replace(/^\n/, "");
}

/**
 * Store the collected multi-line value and reset the accumulator.
 *
 * The common leading indentation is removed so a nested block can be parsed on
 * its own terms. Stripping is done with a string slice rather than a built
 * RegExp: `prefix` is always whitespace (it comes from `/^[ \t]+(?=\S)/m`), so
 * a per-line `slice` is both clearer and immune to pattern injection.
 */
function flushOpenValue(
	frontmatter: Record<string, string>,
	open: OpenValue,
): void {
	if (open.key === null || open.lines === null) return;

	const rawBlock = open.lines.join("\n");
	const prefix = rawBlock.match(/^[ \t]+(?=\S)/m)?.[0] ?? "";
	const stripped = prefix ? stripIndent(rawBlock, prefix) : rawBlock;

	frontmatter[open.key] = open.folded ? foldBlock(stripped) : stripped;
	open.key = null;
	open.lines = null;
	open.indent = null;
	open.folded = false;
}

/** True when a raw scalar is wrapped in matching quotes. */
function isQuoted(rawValue: string): boolean {
	return (
		(rawValue.startsWith('"') && rawValue.endsWith('"')) ||
		(rawValue.startsWith("'") && rawValue.endsWith("'"))
	);
}
