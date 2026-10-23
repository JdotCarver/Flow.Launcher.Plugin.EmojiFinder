// src/types.ts

export type Parameters = Array<string | boolean>;

export type Arguments = {
  method: string
  parameters: Parameters
  settings: Settings
};

export type Settings = {
  enableNotification: boolean
  /** Chosen in SettingsTemplate.yaml, so it arrives as a string ("25"). */
  maxResults?: string
  /** "copy" or "paste": what picking a result does. */
  defaultAction?: string
};

/** The action Flow runs when the user picks a result. */
export type JsonRpcAction = {
  method: string
  parameters: Parameters
};

export type Result = {
  Title: string
  Subtitle: string
  JsonRPCAction?: JsonRpcAction
  IcoPath?: string
  /**
   * The match score. Flow Launcher sorts by it, and adds the user's own selection count on top
   * (`Result.AddSelectedCount`), which is where "the more I use an emoji, the higher it goes"
   * comes from - no state of our own required.
   */
  Score?: number
  /**
   * What Flow counts selections against. Without it, Flow hashes Title+SubTitle, so an emoji
   * whose subtitle changed would lose its history; the emoji itself is the stable identity.
   */
  RecordKey?: string
  /**
   * Handed back to us when the user opens the right-arrow context menu on this result. The
   * emoji itself, so the menu knows what it is acting on without re-deriving it from the title.
   */
  ContextData?: unknown
};

export type JsonRpcRequest = {
  method: string
  parameters: Parameters
};

export type JsonRpcResponse = {
  result: Result[]
};
