import { useQuery } from "@tanstack/react-query";
import { bookingApi } from "../api/booking";
import { fetchMyBookings } from "../api/myBookings";

/**
 * Claims the user's guest bookings, then lists their bookings. A failed claim doesn't
 * block the list: what's already linked still shows, with a note that some may be missing.
 */
export function useMyBookings(userId: string | undefined) {
  return useQuery({
    queryKey: ["my-bookings", userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const claimed = await bookingApi.claim().then(
        () => true,
        () => false,
      );
      return { bookings: await fetchMyBookings(userId!), claimFailed: !claimed };
    },
  });
}
