/**
 * Is a new memory a near-duplicate of one the agent already holds? Cheap and
 * deterministic: token overlap of the name (and the description), no
 * embeddings and no extension. A hit refuses the create and names the
 * candidates; `allowSimilar` is the way through when the agent means it.
 */
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'for', 'to', 'and', 'in', 'on', 'is', 'are']);
const NUMBER_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

/** Lowercase words, number words as digits, a plural `s` stripped. */
export function memoryTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word || STOPWORDS.has(word)) continue;
    const base = NUMBER_WORDS[word] ?? (word.length > 3 ? word.replace(/s$/, '') : word);
    tokens.add(base);
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface SimilarMemory {
  name: string;
  revision: number;
  description: string;
}

const NAME_THRESHOLD = 0.6;
const TEXT_THRESHOLD = 0.5;
const MAX_CANDIDATES = 3;

/** The existing memories a new `name` + `description` nearly repeats, closest first. */
export function similarMemories(
  incoming: { name: string; description: string },
  existing: SimilarMemory[],
): SimilarMemory[] {
  const name = memoryTokens(incoming.name);
  const text = new Set([...name, ...memoryTokens(incoming.description)]);
  return existing
    .map((memory) => {
      const theirName = memoryTokens(memory.name);
      const theirText = new Set([...theirName, ...memoryTokens(memory.description)]);
      const byName = jaccard(name, theirName);
      const byText = jaccard(text, theirText);
      const hit = byName >= NAME_THRESHOLD || byText >= TEXT_THRESHOLD;
      return { memory, score: Math.max(byName, byText), hit };
    })
    .filter((m) => m.hit)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map((m) => m.memory);
}
