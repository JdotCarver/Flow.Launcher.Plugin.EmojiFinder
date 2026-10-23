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
  score?: number
};

export type JsonRpcRequest = {
  method: string
  parameters: Parameters
};

export type JsonRpcResponse = {
  result: Result[]
};
