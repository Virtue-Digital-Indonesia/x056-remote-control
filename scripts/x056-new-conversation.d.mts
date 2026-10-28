// Types for the shared new-conversation guard (plain ESM so the stdio bridge
// runs it under bare node, while the TS server imports it too).
export declare const PROVIDERS: string[];
export declare const CLAUDE_MODELS: string[];
export declare const CLAUDE_EFFORTS: string[];
export declare const CODEX_FALLBACK_EFFORTS: string[];

export interface NewConversationChoiceInput { provider?: unknown; model?: unknown; effort?: unknown; team?: unknown }
export interface NewConversationChoice { provider: 'claude' | 'codex'; model: string; effort: string; team: boolean }
export interface CodexCatalogEntry { slug: string; efforts?: string[] }

export declare function checkNewConversationChoice(
  input: NewConversationChoiceInput | undefined,
  opts?: { codexModels?: CodexCatalogEntry[]; mapCodex?: (model: string, effort: string) => { model: string; effort: string }; teamField?: string; codexList?: CodexCatalogEntry[] },
): { ok: true; choice: NewConversationChoice } | { ok: false; problems: string[]; message: string };

export declare function newConversationMessage(what: string, provider: string | undefined, codexModels: CodexCatalogEntry[] | undefined, teamField?: string): string;
