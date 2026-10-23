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
  /**
   * Keep Flow Launcher on screen after the action runs.
   *
   * Flow hides the window after every action unless this is set (`JsonRPCClientRequestModel`
   * in Flow's `JsonPRCModel`; `ExecuteResultAsync` returns `!DontHideAfterAction`). Only an
   * action that hands control back to the query box would want it; copying and removing should
   * close the window, so nothing sets it today.
   */
  DontHideAfterAction?: boolean
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
  /**
   * Settings Flow Launcher should write on our behalf, applied to its live settings panel too.
   *
   * `JsonRPCPluginBase.ParseResults` calls `Settings.UpdateSettings(...)` with this, which sets the
   * value, updates the open control and saves. It is the supported way to correct a stored setting
   * - writing `Settings.json` ourselves would leave Flow's in-memory copy (and an open settings
   * page) showing the old value until a restart.
   */
  settingsChange?: Record<string, string>;
};
