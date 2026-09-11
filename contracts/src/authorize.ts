import type { FileRef } from './preview-state.js';

export type PreviewAction = 'view' | 'generate' | 'retry' | 'cancel' | 'clear';

export interface Principal {
  readonly tenantId: string;
  readonly userId: string;
  readonly authContext?: Readonly<Record<string, unknown>>;
}

export interface AccessPermissions {
  readonly downloadOriginal: boolean;
  readonly print: boolean;
  readonly copy: boolean;
  readonly retry: boolean;
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly permissions?: AccessPermissions;
}

export interface AuthorizeInput {
  readonly principal: Principal;
  readonly file: FileRef;
  readonly action: PreviewAction;
  readonly signal: AbortSignal;
}

export type Authorize = (input: AuthorizeInput) => Promise<AccessDecision>;
