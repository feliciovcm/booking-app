import { Navigate, Route, Routes } from "react-router";
import { BookingLayout } from "../layouts/BookingLayout";
import { ConsultPage } from "../pages/booking/ConsultPage";
import { LocationStep } from "../pages/booking/LocationStep";
import { ServiceStep } from "../pages/booking/ServiceStep";
import { SlotStep } from "../pages/booking/SlotStep";

export function AppRoutes() {
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
