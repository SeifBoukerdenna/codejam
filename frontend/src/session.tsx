import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getStoredUserId, storeUserId, type User } from "./api";

// Who the demo is "logged in" as, plus the configured business date ("today" = 2026-11-02), shared by
// every page.
type Session = {
  users: User[];
  user: User | null;
  userId: string | null;
  setUserId: (id: string) => void;
  today: string;
};

const SessionContext = createContext<Session | null>(null);

// A link like /approvals?as=U003 opens the app as that user, handy for demo scripts and screenshots.
function initialUserId(): string | null {
  const fromLink = new URLSearchParams(window.location.search).get("as");
  if (fromLink) storeUserId(fromLink);
  return fromLink ?? getStoredUserId();
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserIdState] = useState<string | null>(initialUserId);
  const [today, setToday] = useState("");

  useEffect(() => {
    api<User[]>("/users").then(setUsers).catch(() => setUsers([]));
    api<{ today: string }>("/health").then((h) => setToday(h.today)).catch(() => {});
  }, []);

  const setUserId = useCallback((id: string) => {
    storeUserId(id);
    setUserIdState(id);
  }, []);

  const user = users.find((u) => u.user_id === userId) ?? null;
  return (
    <SessionContext.Provider value={{ users, user, userId, setUserId, today }}>{children}</SessionContext.Provider>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionProvider>");
  return session;
}

/** Fetch an API path; refetches when the path or the current user changes (answers depend on who asks).
 *  While refetching, the previous data stays on screen so the page never flashes empty. */
export function useApi<T>(path: string | null) {
  const { userId } = useSession();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    api<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [path, userId, version]);

  return { data, error, reload: () => setVersion((v) => v + 1) };
}
