// A newly invited buyer was verified against live Xero. Older stored Hub
// evidence must not revoke that access before the contact stream catches up.
export function contactObservedAt(payload) {
  const raw = payload?._hub?.observed_at;
  const observedAt = raw ? new Date(raw) : null;
  if (!observedAt || !Number.isFinite(observedAt.getTime())) {
    throw new Error('Stored Xero contact has no valid source observation time');
  }
  return observedAt;
}

export function observedAfterCreation(observedAt, createdAt) {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return Number.isFinite(created.getTime()) && observedAt.getTime() > created.getTime();
}

export function usersRemovedByContact(users, allowedEmails, observedAt) {
  return users
    .filter((user) => !allowedEmails.has(String(user.xero_person_email || '').toLowerCase())
      && observedAfterCreation(observedAt, user.created_at))
    .map((user) => Number(user.id));
}
