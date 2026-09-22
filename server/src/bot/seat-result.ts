/** Codes in the native passengerTicketStr differ from the query-table codes (ZE/ZY). */
const SUBMITTED_SEATS: Record<string, string> = { O: '二等座', M: '一等座', '9': '商务座', P: '特等座', '1': '硬座', '2': '软座', '3': '硬卧', '4': '软卧', '6': '高级软卧', WZ: '无座' };

export function submittedSeatNames(ticketStr: string, selectedLabels: string[] = []): string[] | null {
  // Encrypted passenger fields may contain underscores; only split at a new row prefix.
  const records = ticketStr.split(/_(?=[^,_]+,0,\d+,)/).filter(Boolean);
  if (!records.length || records.some(record => record.split(',').length < 8)) return null;
  const names = records.map(record => {
    const code = record.split(',')[0].trim();
    return Object.hasOwn(SUBMITTED_SEATS, code) ? SUBMITTED_SEATS[code] : '';
  });
  if (names.some(name => !name)) return null;
  // Only passenger-row selected options may refine the code (e.g. hard-seat code used for standing).
  if (selectedLabels.length) {
    if (selectedLabels.length !== names.length) return null;
    for (let i = 0; i < names.length; i++) {
      const selected = selectedLabels[i].trim().match(/^(商务座|特等座|一等座|二等座|高级软卧|软卧|硬卧|软座|硬座|无座)(?:\s|[（(]|$)/)?.[1];
      if (!selected || (selected !== names[i] && selected !== '无座')) return null;
      names[i] = selected;
    }
  }
  return names;
}
