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

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const block = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	let currentKey: string | null = null;
	let currentLines: string[] | null = null;
	let currentIndent: number | null = null;
	let currentFolded = false;

	const flush = () => {
		if (currentKey === null || currentLines === null) return;
		const rawBlock = currentLines.join("\n");
		const leading = rawBlock.match(/^[ \t]+(?=\S)/m);
		const prefix = leading?.[0] ?? "";
		const stripped = prefix
			? rawBlock
					.replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "")
					.replace(/^\n/, "")
			: rawBlock;
		frontmatter[currentKey] = currentFolded ? foldBlock(stripped) : stripped;
		currentKey = null;
		currentLines = null;
		currentIndent = null;
		currentFolded = false;
	};

	for (const line of block.split("\n")) {
		const indent = line.search(/\S|$/);
		const trimmed = line.trim();

		// Continuation of a block value.
		if (
			currentKey !== null &&
			currentLines !== null &&
			(indent > (currentIndent ?? 0) || (currentFolded && trimmed === ""))
		) {
			currentLines.push(line);
			continue;
		}

		flush();

		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue; // comments, blank lines, stray text

		const key = match[1] as string;
		const rawValue = (match[2] ?? "").trim();
		const quoted =
			(rawValue.startsWith('"') && rawValue.endsWith('"')) ||
			(rawValue.startsWith("'") && rawValue.endsWith("'"));

		if (
			!quoted &&
			(rawValue === "|" ||
				rawValue === "|-" ||
				rawValue === "|+" ||
				rawValue === ">" ||
				rawValue === ">-" ||
				rawValue === ">+")
		) {
			currentKey = key;
			currentLines = [];
			currentIndent = indent;
			currentFolded = rawValue.startsWith(">");
			continue;
		}

		if (rawValue === "") {
			// Either a nested block or an empty value; defer until we see indentation.
			currentKey = key;
			currentLines = [];
			currentIndent = indent;
			currentFolded = false;
			continue;
		}

		frontmatter[key] = stripQuotes(rawValue);
	}

	flush();
	return { frontmatter, body };
}
