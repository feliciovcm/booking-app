import { Navigate, Route, Routes } from "react-router";
import { BookingLayout } from "./funnel/BookingLayout";
import { ConsultPage } from "./funnel/ConsultPage";
import { LocationStep } from "./funnel/LocationStep";
import { ServiceStep } from "./funnel/ServiceStep";
import { SlotStep } from "./funnel/SlotStep";

export default function App() {
  return (
    <Routes>
      <Route path="/book" element={<BookingLayout />}>
        <Route path="services" element={<ServiceStep />} />
        <Route path="location" element={<LocationStep />} />
        <Route path="slot" element={<SlotStep />} />
        <Route path="call" element={<ConsultPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/book/services" replace />} />
    </Routes>
  );
}
