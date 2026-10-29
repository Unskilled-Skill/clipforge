// toLocale{Date,Time}String with options builds a new Intl formatter on
// every call (~60 µs); the library formats thousands of dates per render.
// One formatter per option set, made once.
const formatters = new Map<string, Intl.DateTimeFormat>();

export function formatDate(at: number | Date, options: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(options);
  let format = formatters.get(key);
  if (!format) formatters.set(key, (format = new Intl.DateTimeFormat(undefined, options)));
  return format.format(at);
}
