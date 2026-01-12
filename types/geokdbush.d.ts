declare module "geokdbush" {
  import type KDBush from "kdbush";

  /**
   * Returns an array of the closest points from a given location in order of increasing distance.
   *
   * @param index - A KDBush index
   * @param longitude - Query point longitude
   * @param latitude - Query point latitude
   * @param maxResults - Maximum number of points to return (default: Infinity)
   * @param maxDistance - Maximum distance in kilometers to search within (default: Infinity)
   * @param filterFn - Optional filter function to exclude points
   * @returns Array of point indices sorted by distance
   */
  export function around(
    index: KDBush,
    longitude: number,
    latitude: number,
    maxResults?: number,
    maxDistance?: number,
    filterFn?: (index: number) => boolean,
  ): number[];

  /**
   * Returns the distance in kilometers between two geographic points.
   *
   * @param longitude1 - First point longitude
   * @param latitude1 - First point latitude
   * @param longitude2 - Second point longitude
   * @param latitude2 - Second point latitude
   * @returns Distance in kilometers
   */
  export function distance(longitude1: number, latitude1: number, longitude2: number, latitude2: number): number;
}
