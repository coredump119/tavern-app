import moment from 'moment';

export type MessageTimestamp = string | number | Date | undefined | null;

/** ST utils.parseTimestamp → ISO 8601 字符串 */
export function parseTimestamp(timestamp: MessageTimestamp): string | undefined {
  if (!timestamp) return undefined;
  if (timestamp instanceof Date) return timestamp.toISOString();
  if (typeof timestamp === 'number' || /^\d+$/.test(timestamp)) {
    const unixTime = Number(timestamp);
    const isValid = Number.isFinite(unixTime) && !Number.isNaN(unixTime) && unixTime >= 0;
    if (!isValid) return undefined;
    return new Date(unixTime).toISOString();
  }
  if (moment(timestamp, moment.ISO_8601, true).isValid()) return timestamp;

  type Fmt = { pattern: RegExp; callback: (...m: string[]) => string };
  const dtFmt: Fmt[] = [];

  const convertFromMeridiemBased = (
    _: string,
    month: string,
    day: string,
    year: string,
    hour: string,
    minute: string,
    meridiem: string,
  ) => {
    const monthNum = moment().month(month).format('MM');
    const hour24 =
      meridiem.toLowerCase() === 'pm' ? (parseInt(hour, 10) % 12) + 12 : parseInt(hour, 10) % 12;
    return `${year}-${monthNum}-${day.padStart(2, '0')}T${hour24.toString().padStart(2, '0')}:${minute.padStart(2, '0')}:00`;
  };
  // June 19, 2023 2:20pm
  dtFmt.push({
    callback: convertFromMeridiemBased as Fmt['callback'],
    pattern: /(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i,
  });

  const convertFromHumanized = (
    _: string,
    year: string,
    month: string,
    day: string,
    hour: string,
    min: string,
    sec: string,
    ms?: string,
  ) => {
    const msPart = typeof ms !== 'undefined' ? `.${ms.padStart(3, '0')}` : '';
    return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${min.padStart(2, '0')}:${sec.padStart(2, '0')}${msPart}Z`;
  };
  // 2024-07-12@01h31m37s123ms
  dtFmt.push({
    callback: convertFromHumanized as Fmt['callback'],
    pattern: /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(\d{1,3})ms/,
  });
  // 2024-7-12@01h31m37s
  dtFmt.push({
    callback: convertFromHumanized as Fmt['callback'],
    pattern: /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s/,
  });
  // 2024-6-5 @14h 56m 50s 682ms
  dtFmt.push({
    callback: convertFromHumanized as Fmt['callback'],
    pattern: /(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m (\d{1,2})s (\d{1,3})ms/,
  });

  for (const x of dtFmt) {
    const m = timestamp.match(x.pattern);
    if (!m) continue;
    return x.callback(...(m as unknown as string[]));
  }
  return undefined;
}

/** ST utils.timestampToMoment（不做缓存） */
export function timestampToMoment(timestamp: MessageTimestamp, locale = 'en'): moment.Moment {
  const iso = parseTimestamp(timestamp);
  return iso ? moment(iso).locale(locale) : moment.invalid();
}

/** 当前时刻；state.now 可注入以便测试 */
export function nowMoment(now?: (() => Date | number) | undefined, locale = 'en'): moment.Moment {
  const m = now ? moment(now()) : moment();
  return m.locale(locale);
}
