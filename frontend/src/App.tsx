import { useEffect, useState } from "react";

type ApiStatus = "checking" | "ok" | "unavailable";

export function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health/ready")
      .then((response) => response.ok)
      .catch(() => false)
      .then((ok) => {
        if (!cancelled) setApiStatus(ok ? "ok" : "unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>TrailStat</h1>
      <p>API status: {apiStatus}</p>
    </main>
  );
}
