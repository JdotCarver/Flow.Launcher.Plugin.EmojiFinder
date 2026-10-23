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

export type Result = {
  Title: string
  Subtitle: string
  JsonRPCAction?: {
    method: string
    parameters: Parameters
  }
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
