import { useCallback, useState, type FormEvent } from "react";

import { Button } from "@/components/kit";
import { useAuth } from "@/store/AuthProvider";

export default function Login() {
  const { signIn } = useAuth();
  const [username, setUsername] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [error, setError] = useState<string>("");

  const submit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const result = signIn(username, password);
      if (!result.ok) setError(result.error ?? "Access denied");
    },
    [signIn, username, password],
  );

  return (
    <div className="grid min-h-screen place-items-center bg-background scanlines px-5">
      <div className="w-full max-w-[320px] animate-fade-in">
        <div className="mb-5 flex items-center gap-2">
          <span className="h-[15px] w-[3px] rounded-full bg-primary" />
          <span className="num text-[13px] font-semibold uppercase tracking-[0.18em]">
            Nova<span className="text-primary">DCA</span>
          </span>
          <span className="num ml-auto text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
            terminal <span className="animate-blink text-primary">●</span>
          </span>
        </div>

        <form onSubmit={submit} className="panel space-y-2.5 p-4">
          <div>
            <label htmlFor="login-user" className="lbl mb-1 block">
              Username
            </label>
            <input
              id="login-user"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError("");
              }}
              autoComplete="username"
              autoFocus
              className="field"
            />
          </div>

          <div>
            <label htmlFor="login-pass" className="lbl mb-1 block">
              Password
            </label>
            <input
              id="login-pass"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
              autoComplete="current-password"
              className="field"
            />
          </div>

          {error ? (
            <p className="num rounded-[3px] border border-neg/30 bg-neg-soft px-2 py-1.5 text-[10.5px] uppercase tracking-[0.08em] text-neg">
              {error}
            </p>
          ) : null}

          <Button type="submit" tone="solid" className="w-full">
            Authenticate
          </Button>
        </form>
      </div>
    </div>
  );
}
