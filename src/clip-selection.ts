export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const result = [...items];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= result.length || to >= result.length || from === to) return result;
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}
