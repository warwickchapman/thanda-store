# Application naming

The application is **Thanda Store**. Use these names for current configuration:

| Item | Canonical name |
| --- | --- |
| Repository, npm package and application service | `thanda-store` |
| Production checkout | `/root/thanda-store` |
| Next.js application directory | `/root/thanda-store/thanda-store` |
| PostgreSQL database | `thanda_store` |
| PostgreSQL application login role | `thanda_user` |

The database and login were renamed in place on 1 November 2026, from
`renogy_store` and `renogy_user`. Their PostgreSQL identities, ownership and grants
were retained. Counts for products, companies, users, quote requests and account
documents were unchanged. Runtime connection settings and both ends of Fleet
monitoring were updated together; the Store and its monitoring checks passed.

Renogy remains a supplier. Its catalogue names, supplier identifiers, API hosts,
product images, synchronization jobs and related database objects retain
`renogy` where they describe that integration. They are not old application
branding.

The obsolete CSV importer and its trigger have been removed. They referred to an
old application path, and the importer could replace the complete product table.
The supported supplier synchronization commands are documented in the root
README.

## Database maintenance

Rename the existing database and login role in place. PostgreSQL retains their
object identities, data, ownership and grants; the rename does not transfer
database ownership to the application role or require a data copy. Update every
consumer's connection configuration together, including the web process,
scheduled jobs, operational scripts and backup configuration.

Coordinate a maintenance window: pause Store writers, scheduled work and backups;
take a verified backup; stop connections before renaming the database; update
configuration; then restart and verify the application, worker connections and a
new backup. Resume scheduled jobs and backups only after those checks. Keep a
rollback plan that restores both names and all connection settings consistently.

The 1 November 2026 inventory identified these cutover points:

- Store runtime: `/etc/thanda-store-hub.json`, the supplier and Xero environment
  files under `/etc`, and both saved PM2 process dumps.
- Off-site backup: `/usr/local/sbin/thanda-store-offsite-backup` and its operations
  README. New database archives use the current database name.
- Remote monitoring: `/etc/fleet-applications/host.json` and the installed Fleet
  protocol's database allowlist on the application server.
- Central monitoring on `v.crystalise.co`: the Fleet collector registry, protocol
  allowlist, and Grafana database labels and queries. Update both ends together;
  changing only the application server would make the collector reject its data.
- Obsolete, untracked source at the checkout root: archive it securely, then remove
  it after confirming that PM2 and every job use the nested application directory.

Historical Git commits, monitoring samples and existing backup archives keep their original names.
Do not rewrite history or rename immutable backup records to hide their origin.
When restoring an older backup, explicitly target `thanda_store` and map its
application privileges to `thanda_user`; do not recreate the old database or login
role merely because an archive records those names. Check ownership and grants
after the restore.
