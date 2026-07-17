export interface ResourceResult<T> {
  data: T;
  error: string | null;
}

export async function loadResource<T>(
  loader: () => Promise<T>,
  fallback: T,
): Promise<ResourceResult<T>> {
  try {
    return { data: await loader(), error: null };
  } catch (error) {
    return {
      data: fallback,
      error: error instanceof Error ? error.message : 'API 请求失败',
    };
  }
}
