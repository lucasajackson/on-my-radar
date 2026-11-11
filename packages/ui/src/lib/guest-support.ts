import type {
  GuestSupportCredentialsDto,
  GuestSupportThreadDto,
  GuestSupportRequestInput,
  SupportReplyInput,
} from '@onmyradar/contract';
import { ApiError } from './api';
import { apiUrl } from './config';
async function call<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(`/api/guest-support${path}`), {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Support ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      result &&
      typeof result === 'object' &&
      'error' in result &&
      result.error &&
      typeof result.error === 'object' &&
      'code' in result.error
        ? String(result.error.code)
        : 'unavailable';
    throw new ApiError(
      response.status,
      code,
      response.status === 404
        ? 'This conversation link is unavailable. Use your saved recovery code or start another request.'
        : response.status === 429
          ? 'Several requests have been sent. Keep your text and try again later.'
          : response.status === 409
            ? 'This operation conflicts with an earlier submission. Refresh the conversation before trying again.'
            : 'Support could not confirm this operation. Your text is still here; try again.',
    );
  }
  if (result === null)
    throw new Error('Support returned an invalid response. Keep your text and try again.');
  return result as T;
}
export const guestSupportApi = {
  start: () => call<GuestSupportCredentialsDto>('/start', undefined, {}),
  get: (token: string, after?: string) =>
    call<GuestSupportThreadDto>(
      `/conversation${after ? `?after=${encodeURIComponent(after)}` : ''}`,
      token,
    ),
  create: (token: string, input: GuestSupportRequestInput) =>
    call<GuestSupportThreadDto>('/conversation', token, input),
  reply: (token: string, input: SupportReplyInput) =>
    call<GuestSupportThreadDto>('/conversation/replies', token, input),
  recover: (recoveryCode: string) =>
    call<{ token: string; expiresAt: string }>('/recover', undefined, { recoveryCode }),
  revoke: (token: string) => call<{ revoked: true }>('/conversation/revoke', token, {}),
};
