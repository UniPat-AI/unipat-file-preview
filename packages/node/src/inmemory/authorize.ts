import type {
  Authorize,
  AuthorizeInput,
  AccessDecision,
} from '@unipat/file-preview-contracts';

/**
 * 默认放行的 Authorize，仅用于本地示例和测试。
 * 生产接入必须实现真实的权限校验。
 */
export const allowAllAuthorize: Authorize = async (
  _input: AuthorizeInput,
): Promise<AccessDecision> => ({
  allowed: true,
  permissions: {
    downloadOriginal: true,
    print: true,
    copy: true,
    retry: true,
  },
});
