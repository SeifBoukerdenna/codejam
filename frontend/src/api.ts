// Every request carries the user picked in the switcher as X-User-Id. The server decides what that user may
// do; the UI only hides buttons for convenience, it never enforces anything.

const USER_KEY = "harborline.userId";

export function getCurrentUserId(): string | null {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null; // storage can be blocked (private window); the app then just starts with no user picked
  }
}

export function setCurrentUserId(userId: string): void {
  try {
    localStorage.setItem(USER_KEY, userId);
  } catch {
    // not persisted across reloads, but the in-memory choice still works
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const userId = getCurrentUserId();
  if (userId) headers.set("X-User-Id", userId);
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export type User = {
  user_id: string;
  full_name: string;
  title: string;
  role: string;
  status: string;
  department_id: string;
  department: string;
};
