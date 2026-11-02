// Short term conversation memory: the last few messages of an ongoing chat,
// held in this process' memory only. It exists so a follow up like "tuesday
// also" can be read together with the question it answers. Never persisted,
// never logged, and gone when the app restarts, so there is nothing to erase.

export type ConversationRole = "student" | "settle";

export type ConversationTurn = {
  role: ConversationRole;
  text: string;
};

export type ConversationMemoryOptions = {
  // Turns older than this are dropped. Default: 10 minutes.
  ttlMs?: number;
  // Per user, only the most recent turns are kept. Default: 4.
  maxTurns?: number;
  // Users held at once; the least recently used one is evicted beyond this.
  // Default: 1000.
  maxUsers?: number;
  // Each turn's text is trimmed and cut to this length. Default: 500.
  maxTextChars?: number;
  now?: () => number;
};

export type ConversationMemory = {
  remember: (userKey: string, turn: ConversationTurn) => void;
  // Oldest first; empty for an unknown user or one whose turns expired.
  recent: (userKey: string) => ConversationTurn[];
};

export function createConversationMemory(
  options: ConversationMemoryOptions = {},
): ConversationMemory {
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const maxTurns = options.maxTurns ?? 4;
  const maxUsers = options.maxUsers ?? 1000;
  const maxTextChars = options.maxTextChars ?? 500;
  const now = options.now ?? (() => Date.now());

  // Map keys keep insertion order, and re-inserting a key moves it to the
  // end, so the first key is always the least recently used user.
  const users = new Map<string, Array<(ConversationTurn & { at: number })>>();

  function touch(userKey: string): void {
    const entry = users.get(userKey);
    if (entry === undefined) return;
    users.delete(userKey);
    users.set(userKey, entry);
  }

  function freshTurns(userKey: string): Array<ConversationTurn & { at: number }> {
    const entry = users.get(userKey);
    if (entry === undefined) return [];
    const nowMs = now();
    return entry.filter((turn) => nowMs - turn.at < ttlMs);
  }

  return {
    remember(userKey, turn) {
      const text = turn.text.trim();
      const kept = text.length > maxTextChars ? text.slice(0, maxTextChars) : text;
      touch(userKey);
      let turns = users.get(userKey);
      if (turns === undefined) {
        turns = [];
        users.set(userKey, turns);
      }
      turns.push({ role: turn.role, text: kept, at: now() });
      if (turns.length > maxTurns) users.set(userKey, turns.slice(-maxTurns));
      while (users.size > maxUsers) {
        const oldest = users.keys().next();
        if (oldest.done) break;
        users.delete(oldest.value);
      }
    },

    recent(userKey) {
      touch(userKey);
      const kept = freshTurns(userKey);
      return kept.map(({ role, text }) => ({ role, text }));
    },
  };
}

// The one instance the running bot uses. Tests build their own through
// createConversationMemory so clocks and limits are under their control.
export const conversationMemory = createConversationMemory();
