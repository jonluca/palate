import React, { useEffect, useMemo, useRef } from "react";
import type { NearbyRestaurant } from "@/hooks/queries";
import {
  cleanCalendarEventTitle,
  compareRestaurantAndCalendarTitle,
  isFuzzyRestaurantMatch,
} from "@/services/calendar";

interface AutoRestaurantSelectorRenderArgs {
  displayRestaurants: NearbyRestaurant[];
  onSelectRestaurant: (restaurant: NearbyRestaurant) => void;
}

interface AutoRestaurantSelectorProps {
  restaurants: NearbyRestaurant[];
  calendarEventTitle?: string | null;
  selectedRestaurant: NearbyRestaurant | null;
  onSelectedRestaurantChange: (restaurant: NearbyRestaurant | null) => void;
  hasExactMatch?: boolean;
  selectionResetKey?: string | number;
  children: (args: AutoRestaurantSelectorRenderArgs) => React.ReactNode;
}

export function AutoRestaurantSelector({
  restaurants,
  calendarEventTitle,
  selectedRestaurant,
  onSelectedRestaurantChange,
  hasExactMatch = false,
  selectionResetKey,
  children,
}: AutoRestaurantSelectorProps) {
  const manualSelectionRef = useRef(false);

  useEffect(() => {
    manualSelectionRef.current = false;
  }, [selectionResetKey]);

  const cleanedCalendarTitle = useMemo(
    () => (calendarEventTitle ? cleanCalendarEventTitle(calendarEventTitle) : ""),
    [calendarEventTitle],
  );

  const displayRestaurants = useMemo(() => {
    if (!cleanedCalendarTitle || restaurants.length === 0) {
      return restaurants;
    }

    return [...restaurants].sort((a, b) => {
      const aMatches = isFuzzyRestaurantMatch(a.name, cleanedCalendarTitle);
      const bMatches = isFuzzyRestaurantMatch(b.name, cleanedCalendarTitle);

      if (aMatches && !bMatches) {
        return -1;
      }
      if (!aMatches && bMatches) {
        return 1;
      }

      if (aMatches && bMatches) {
        const aIsMichelin = a.source === "michelin";
        const bIsMichelin = b.source === "michelin";
        if (aIsMichelin && !bIsMichelin) {
          return -1;
        }
        if (!aIsMichelin && bIsMichelin) {
          return 1;
        }
      }

      return a.distance - b.distance;
    });
  }, [cleanedCalendarTitle, restaurants]);

  const exactAutoMatch = useMemo(() => {
    if (!calendarEventTitle || restaurants.length === 0) {
      return null;
    }
    return (
      restaurants.find((restaurant) => compareRestaurantAndCalendarTitle(calendarEventTitle, restaurant.name)) ?? null
    );
  }, [calendarEventTitle, restaurants]);

  const fuzzyAutoMatch = useMemo(() => {
    if (!cleanedCalendarTitle || restaurants.length === 0) {
      return null;
    }

    const fuzzyMatches = restaurants.filter((restaurant) =>
      isFuzzyRestaurantMatch(restaurant.name, cleanedCalendarTitle),
    );
    if (fuzzyMatches.length === 0) {
      return null;
    }

    return (
      [...fuzzyMatches].sort((a, b) => {
        const aIsMichelin = a.source === "michelin";
        const bIsMichelin = b.source === "michelin";
        if (aIsMichelin && !bIsMichelin) {
          return -1;
        }
        if (!aIsMichelin && bIsMichelin) {
          return 1;
        }
        return a.distance - b.distance;
      })[0] ?? null
    );
  }, [cleanedCalendarTitle, restaurants]);

  useEffect(() => {
    if (hasExactMatch || restaurants.length === 0) {
      return;
    }

    if (manualSelectionRef.current) {
      return;
    }

    if (exactAutoMatch) {
      if (!selectedRestaurant || selectedRestaurant.id !== exactAutoMatch.id) {
        onSelectedRestaurantChange(exactAutoMatch);
      }
      return;
    }

    if (!selectedRestaurant && fuzzyAutoMatch) {
      onSelectedRestaurantChange(fuzzyAutoMatch);
    }
  }, [hasExactMatch, restaurants, exactAutoMatch, fuzzyAutoMatch, selectedRestaurant, onSelectedRestaurantChange]);

  const handleSelectRestaurant = (restaurant: NearbyRestaurant) => {
    manualSelectionRef.current = true;
    onSelectedRestaurantChange(restaurant);
  };

  return <>{children({ displayRestaurants, onSelectRestaurant: handleSelectRestaurant })}</>;
}
