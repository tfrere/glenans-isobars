import { useCallback, useEffect, useState } from "react";
import { fetchIsobarGrid, type IsobarGrid } from "./api";

interface IsobarState {
  data: IsobarGrid | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useIsobars(enabled = true): IsobarState {
  const [data, setData] = useState<IsobarGrid | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchIsobarGrid(controller.signal)
      .then((grid) => setData(grid))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [nonce, enabled]);

  return { data, loading, error, reload };
}
