import { BrowserRouter, Route, Routes } from "react-router";
import AppShell from "./components/AppShell";
import { Empty, Page } from "./components/ui";
import Activity from "./pages/Activity";
import Approvals from "./pages/Approvals";
import Fool from "./pages/Fool";
import Home from "./pages/Home";
import Inbox from "./pages/Inbox";
import InvoiceDetail from "./pages/InvoiceDetail";
import Payments from "./pages/Payments";
import VendorDetail from "./pages/VendorDetail";
import Vendors from "./pages/Vendors";
import { SessionProvider } from "./session";

export default function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Home />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="approvals" element={<Approvals />} />
            <Route path="payments" element={<Payments />} />
            <Route path="vendors" element={<Vendors />} />
            <Route path="vendors/:vendorId" element={<VendorDetail />} />
            <Route path="invoices/:invoiceId" element={<InvoiceDetail />} />
            <Route path="activity" element={<Activity />} />
            <Route path="fool" element={<Fool />} />
            <Route path="*" element={<Page><Empty title="Page not found">Check the address, or go back home.</Empty></Page>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
