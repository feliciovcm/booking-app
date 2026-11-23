import { useQuery } from "@tanstack/react-query";
import { fetchLocations, fetchTreatments } from "../api/catalog";

// Config changes rarely, so cache it for the whole visit instead of refetching per step.
const CONFIG_STALE_TIME = 10 * 60 * 1000;

export const useTreatments = () =>
  useQuery({ queryKey: ["treatments"], queryFn: fetchTreatments, staleTime: CONFIG_STALE_TIME });

export const useLocations = () =>
  useQuery({ queryKey: ["locations"], queryFn: fetchLocations, staleTime: CONFIG_STALE_TIME });
