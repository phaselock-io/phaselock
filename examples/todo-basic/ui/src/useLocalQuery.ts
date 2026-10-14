import type { Query, QueryFunction } from '@todo-basic/model/ui';
import { useEffect, useState } from 'react';

/** The latest result of a query over an Engine, or undefined until it first answers. */
export function useLocalQuery<QX, T>(
  // structurally match QX parameter from Engine
  eng: { newQuery<X>(fn: QueryFunction<QX, X>): Query<X> },
  fn: QueryFunction<QX, T>,
): T | undefined {
  const [state, setState] = useState<T | undefined>();

  useEffect(() => {
    const query = eng.newQuery(fn);
    query.subscribe((val: T) => setState(() => val));
    return () => query.close();
  }, [eng, fn]);

  return state;
}
