import { paths, type ApiError, type MeResponse, type MeUser } from '@dub/shared';
import { useMe } from '@/state/me';

/** V04 account calls. Each successful call updates the `useMe` store. */

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(url: string, init: RequestInit): Promise<Response> {
  const r = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as ApiError | null;
    throw new AccountError(body?.message ?? `HTTP ${r.status}`, r.status);
  }
  return r;
}

async function setMe(r: Response): Promise<MeUser> {
  const { user } = (await r.json()) as MeResponse;
  useMe.setState({ user, status: 'ready' });
  return user;
}

/** Emails a sign-in link (the server answers the same whether or not the account exists). */
export async function requestLoginLink(email: string): Promise<void> {
  await call(paths.authRequest(), { method: 'POST', body: JSON.stringify({ email }) });
}

export async function logout(): Promise<MeUser> {
  return setMe(await call(paths.authLogout(), { method: 'POST' }));
}

export async function rename(displayName: string): Promise<MeUser> {
  return setMe(
    await call(paths.me(), { method: 'PATCH', body: JSON.stringify({ displayName }) }),
  );
}

export async function deleteAccount(): Promise<MeUser> {
  return setMe(await call(paths.me(), { method: 'DELETE' }));
}
