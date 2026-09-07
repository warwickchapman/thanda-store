import Link from "next/link";

export default function ReplenishmentHowItWorksPage() {
  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <nav className="mb-6 flex gap-4 border-b border-zinc-200 pb-3 text-sm font-semibold">
          <Link href="/admin/replenishment">Replenishment</Link>
          <Link href="/admin/victron-inbound">Inbound</Link>
          <Link href="/admin/victron-stock-minima">Minimums</Link>
          <span>How recommendations work</span>
        </nav>
        <h1 className="text-2xl font-bold">How recommendations work</h1>
        <div className="mt-5 space-y-6 rounded-lg border border-zinc-200 bg-white p-5 text-sm">
          <section>
            <h2 className="font-bold">Demand and targets</h2>
            <p className="mt-2 text-zinc-700">
              <b>30d</b> and <b>90d</b> are invoiced sales, net of credit notes.
              Accepted quotes do not contribute to either sales figure. The
              system uses the higher of the 30-day and 90-day daily sales rates.
            </p>
            <p className="mt-2 text-zinc-700">
              <b>Minimum</b> is the floor you maintain in Minimums; it is not an
              order quantity. The <b>7-day Target</b> is five days of lead time
              plus two days of safety stock, or the Minimum—whichever is higher.
              The <b>14-day Target</b> is 14 days of demand, or the Minimum—again
              whichever is higher. Targets are rounded to the nearest whole unit.
            </p>
          </section>

          <section className="border-t border-zinc-200 pt-5">
            <h2 className="font-bold">Stock position</h2>
            <p className="mt-2 text-zinc-700">
              <b>Stock</b> is the KZN quantity supplied by Xero. <b>Inbound</b>
              is outstanding expected quantity from Victron shipment invoices.
              <b>Backorder</b> is Victron&apos;s current remaining backorder snapshot;
              it counts toward coverage but is shown separately. If the same order
              and SKU family is already open as inbound, the overlap is removed so
              it is not counted twice.
            </p>
            <p className="mt-2 text-zinc-700">
              <b>Cart</b> is a temporary saved E-Order basket upload. It is not an
              order and can be replaced or cleared at any time.
            </p>
          </section>

          <section className="border-t border-zinc-200 pt-5">
            <h2 className="font-bold">Accepted Xero quotes</h2>
            <p className="mt-2 text-zinc-700">
              <b>Quotes</b> reserves matching Victron quantities on current
              accepted Xero quotes. Reservations reduce available stock position,
              so they increase Suggested where appropriate. They are not sales and
              do not alter 30d or 90d demand.
            </p>
            <p className="mt-2 text-zinc-700">
              The quote snapshot refreshes every 30 minutes after the stock sync;
              use <b>Check accepted quotes</b> on Replenishment when you need an
              immediate refresh. RMA quotes and quotes older than 90 days are
              excluded. The age window is configurable with
              {" "}<code>XERO_ACCEPTED_QUOTE_RESERVATION_DAYS</code>.
            </p>
          </section>

          <section className="border-t border-zinc-200 pt-5">
            <h2 className="font-bold">Suggested and receipt</h2>
            <p className="mt-2 text-zinc-700">
              <b>Suggested</b> starts with the 14-day Target, subtracts Stock,
              Inbound and Backorder, adds Quotes reserved on accepted Xero quotes,
              then subtracts Cart. The final value is rounded to the nearest whole
              unit. Hover over a Suggested value to see its Minimum, 7-day Target,
              14-day Target and quote reservation.
            </p>
            <p className="mt-2 text-zinc-700">
              A Victron shipment establishes what is expected, not what physically
              arrived. In Inbound, use <b>Confirm all</b> or <b>Confirm partial</b>
              only after counting the delivery. Confirmation removes the expected
              quantity from Inbound; it never adds stock to Xero. Xero remains the
              authority for Stock.
            </p>
          </section>

          <p className="border-t border-zinc-200 pt-5 text-zinc-700">
            SKU replacements and retail SKUs ending in <b>R</b> use the same stock
            family throughout sales, stock, inbound, backorders, cart and quotes.
          </p>
        </div>
      </div>
    </main>
  );
}
