/* Class catalogue — spec §3.
 *
 * Durations are fixed per class type so billable minutes never have to be typed.
 * `seats` decides how many clients an entry takes:
 *    1     = individual
 *    2     = exactly two (2-on-1)
 *    'many'= group, any number of attendees on one row
 *
 * OTHER is not in the original spec. It exists so an unusual session (comp,
 * trial, an odd duration) can still be logged instead of forcing a wrong code.
 * It is the only type where minutes are entered by hand.
 */
const CATALOGUE = [
  { code: 'GRP60',  label: 'Group class',            minutes: 60, seats: 'many', group: 'Group' },
  { code: 'GRP30',  label: 'Group class',            minutes: 30, seats: 'many', group: 'Group' },
  { code: 'BOX30',  label: 'Group boxing',           minutes: 30, seats: 'many', group: 'Group' },
  { code: 'ATH60',  label: 'Athletes class',         minutes: 60, seats: 'many', group: 'Group' },

  { code: 'IND60',  label: 'Individual class',       minutes: 60, seats: 1,      group: 'Individual' },
  { code: 'IND30',  label: 'Individual class',       minutes: 30, seats: 1,      group: 'Individual' },
  { code: 'STR30',  label: 'Stretching',             minutes: 30, seats: 1,      group: 'Individual' },
  { code: 'RLT30',  label: 'Red light therapy',      minutes: 30, seats: 1,      group: 'Individual' },

  { code: 'TWO60',  label: '2-on-1',                 minutes: 60, seats: 2,      group: '2-on-1' },
  { code: 'TWO30',  label: '2-on-1',                 minutes: 30, seats: 2,      group: '2-on-1' },

  { code: 'NUTG60', label: 'Nutrition — group',      minutes: 60, seats: 'many', group: 'Nutrition' },
  { code: 'NUTG30', label: 'Nutrition — group',      minutes: 30, seats: 'many', group: 'Nutrition' },
  { code: 'NUTI60', label: 'Nutrition — individual', minutes: 60, seats: 1,      group: 'Nutrition' },
  { code: 'NUTI30', label: 'Nutrition — individual', minutes: 30, seats: 1,      group: 'Nutrition' },

  { code: 'OTHER',  label: 'Other',                  minutes: null, seats: 'many', group: 'Other' }
];

const CLASS_BY_CODE = Object.fromEntries(CATALOGUE.map(c => [c.code, c]));

/* Attendance status — spec §10.1.
 * Held per attendee, not per session, so one no-show in a group of eight does
 * not mark the whole class as a no-show.
 * `billable` drives the billable-minutes total in the report. */
/* The billing rule, confirmed by Mido 2026-08-26: a cancellation given 24 hours
 * or more in advance is not billable. Everything else is — a no-show, and a
 * cancellation inside 24 hours.
 *
 * The labels name the 24-hour line explicitly rather than saying "late" and
 * "notice". Not for whoever is logging -- that is Mido, who knows the policy --
 * but for accounting, who read these exact strings in the CSV and need to see
 * why a line is unbilled. This is the only place billing behaviour is defined. */
const STATUSES = [
  { code: 'attended',    label: 'Attended',                   billable: true,  short: 'OK'  },
  { code: 'noshow',      label: 'No-show',                    billable: true,  short: 'NS'  },
  { code: 'cancel_late', label: 'Cancelled — under 24h',      billable: true,  short: '<24' },
  { code: 'cancel_ok',   label: 'Cancelled — 24h+ notice',    billable: false, short: '24+' }
];

const STATUS_BY_CODE = Object.fromEntries(STATUSES.map(s => [s.code, s]));

function classLabel(code) {
  const c = CLASS_BY_CODE[code];
  if (!c) return code;
  return c.minutes ? `${c.label} (${c.minutes}m)` : c.label;
}
