import { Navigate, Route, Routes } from "react-router";
import { AccountLayout } from "../layouts/AccountLayout";
import { BookingLayout } from "../layouts/BookingLayout";
import { MyBookingsPage } from "../pages/account/MyBookingsPage";
import { SignInPage } from "../pages/account/SignInPage";
import { CheckoutStep } from "../pages/booking/CheckoutStep";
import { ConfirmedPage } from "../pages/booking/ConfirmedPage";
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
        <Route path="checkout" element={<CheckoutStep />} />
        <Route path="confirmed" element={<ConfirmedPage />} />
        <Route path="call" element={<ConsultPage />} />
      </Route>
      <Route element={<AccountLayout />}>
        <Route path="sign-in" element={<SignInPage />} />
        <Route path="my-bookings" element={<MyBookingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/book/services" replace />} />
    </Routes>
  );
}
