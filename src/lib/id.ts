import { customAlphabet } from "nanoid";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const nano6 = customAlphabet(ALPHABET, 6);

/**
 * Short, human-shoutable identifier used for inline image references in the
 * terminal flow ("img_a3f2zx"). Six base36-ish chars give us ~2.1B unique
 * values — collisions are vanishingly unlikely at session scope.
 */
export function newImageId(): string {
  return `img_${nano6()}`;
}

/** Same shape but for terminal session IDs ("session_..."). */
export function newSessionId(): string {
  return `session_${nano6()}`;
}
