export interface JsonRpcRequest {
  id?: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params?: any;
}

export type AppServerMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;
