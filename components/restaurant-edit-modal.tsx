import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Card, Button } from "@/components/ui";
import { usePlaceTextSearch, type PlaceResult } from "@/hooks/queries";
import { getPlaceDetails } from "@/services/places";
import { useGoogleMapsApiKey } from "@/store";
import type { RestaurantRecord, UpdateRestaurantData } from "@/utils/db";
import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Pressable,
  Modal,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";

interface RestaurantEditModalProps {
  visible: boolean;
  onClose: () => void;
  onSave: (data: UpdateRestaurantData) => Promise<void>;
  restaurant: RestaurantRecord;
}

function InputField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  multiline = false,
  autoCapitalize = "sentences",
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "numeric" | "phone-pad" | "url";
  multiline?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
}) {
  return (
    <View className={"gap-1.5"}>
      <ThemedText variant={"footnote"} color={"secondary"} className={"font-medium"}>
        {label}
      </ThemedText>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={"#6b7280"}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        multiline={multiline}
        numberOfLines={multiline ? 3 : 1}
        className={"bg-secondary rounded-lg px-4 py-3 text-foreground"}
        style={multiline ? { minHeight: 80, textAlignVertical: "top" } : undefined}
      />
    </View>
  );
}

function PriceLevelSelector({ value, onChange }: { value: number | null; onChange: (level: number | null) => void }) {
  const levels = [1, 2, 3, 4];

  return (
    <View className={"gap-1.5"}>
      <ThemedText variant={"footnote"} color={"secondary"} className={"font-medium"}>
        Price Level
      </ThemedText>
      <View className={"flex-row gap-2"}>
        {levels.map((level) => (
          <Pressable
            key={level}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onChange(value === level ? null : level);
            }}
            className={`flex-1 py-3 rounded-lg items-center ${value === level ? "bg-primary" : "bg-secondary"}`}
          >
            <ThemedText
              variant={"subhead"}
              className={value === level ? "text-primary-foreground font-semibold" : "text-foreground"}
            >
              {"$".repeat(level)}
            </ThemedText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function GooglePlaceSearchResult({
  place,
  onSelect,
  isLoading,
}: {
  place: PlaceResult;
  onSelect: () => void;
  isLoading: boolean;
}) {
  return (
    <Pressable onPress={onSelect} disabled={isLoading}>
      <Card animated={false}>
        <View className={"p-3 gap-1"}>
          <View className={"flex-row items-start justify-between"}>
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"font-medium"}>
                {place.name}
              </ThemedText>
              {place.address && (
                <ThemedText variant={"footnote"} color={"tertiary"} numberOfLines={1}>
                  {place.address}
                </ThemedText>
              )}
            </View>
            <View className={"items-end"}>
              {place.rating !== undefined && (
                <View className={"flex-row items-center gap-1"}>
                  <ThemedText variant={"footnote"} className={"text-amber-400"}>
                    ★
                  </ThemedText>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    {place.rating.toFixed(1)}
                  </ThemedText>
                </View>
              )}
              {isLoading && <ActivityIndicator size={"small"} />}
            </View>
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

export function RestaurantEditModal({ visible, onClose, onSave, restaurant }: RestaurantEditModalProps) {
  // Form state
  const [name, setName] = useState(restaurant.name);
  const [address, setAddress] = useState(restaurant.address ?? "");
  const [phone, setPhone] = useState(restaurant.phone ?? "");
  const [website, setWebsite] = useState(restaurant.website ?? "");
  const [cuisine, setCuisine] = useState(restaurant.cuisine ?? "");
  const [priceLevel, setPriceLevel] = useState<number | null>(restaurant.priceLevel);
  const [notes, setNotes] = useState(restaurant.notes ?? "");

  // Google search state
  const [showGoogleSearch, setShowGoogleSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadingPlaceId, setLoadingPlaceId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Check if Google Maps API key is configured
  const googleMapsApiKey = useGoogleMapsApiKey();
  const hasGoogleMapsKey = !!googleMapsApiKey;

  // Track if we've triggered the initial auto-search for this modal session
  const hasAutoSearched = useRef(false);

  // Use the query hook for place text search
  const {
    data: searchResults = [],
    isLoading: isSearching,
    refetch: refetchSearch,
  } = usePlaceTextSearch(
    searchQuery,
    restaurant.latitude,
    restaurant.longitude,
    showGoogleSearch && searchQuery.trim().length > 0,
  );

  // Reset form when restaurant changes
  useEffect(() => {
    setName(restaurant.name);
    setAddress(restaurant.address ?? "");
    setPhone(restaurant.phone ?? "");
    setWebsite(restaurant.website ?? "");
    setCuisine(restaurant.cuisine ?? "");
    setPriceLevel(restaurant.priceLevel);
    setNotes(restaurant.notes ?? "");
    setShowGoogleSearch(false);
    setSearchQuery("");
    hasAutoSearched.current = false;
  }, [restaurant]);

  // Auto-search when modal becomes visible and Google Maps key is configured
  useEffect(() => {
    if (visible && hasGoogleMapsKey && !hasAutoSearched.current) {
      hasAutoSearched.current = true;
      setShowGoogleSearch(true);
      setSearchQuery(restaurant.name);
    }
  }, [visible, hasGoogleMapsKey, restaurant.name]);

  // Reset auto-search flag when modal closes
  useEffect(() => {
    if (!visible) {
      hasAutoSearched.current = false;
    }
  }, [visible]);

  const handleSearch = () => {
    if (!searchQuery.trim()) {
      return;
    }
    refetchSearch();
  };

  const handleSelectPlace = async (place: PlaceResult) => {
    setLoadingPlaceId(place.placeId);
    try {
      const details = await getPlaceDetails(place.placeId);
      if (details) {
        // Populate form with Google data
        setName(details.name);
        if (details.address) {
          setAddress(details.address);
        }
        if (details.phone) {
          setPhone(details.phone);
        }
        if (details.website) {
          setWebsite(details.website);
        }
        if (details.priceLevel !== null) {
          setPriceLevel(details.priceLevel);
        }

        // Exit search mode
        setShowGoogleSearch(false);
        setSearchQuery("");

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (error) {
      console.error("Failed to get place details:", error);
    } finally {
      setLoadingPlaceId(null);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({
        name: name.trim(),
        address: address.trim() || null,
        phone: phone.trim() || null,
        website: website.trim() || null,
        cuisine: cuisine.trim() || null,
        priceLevel,
        notes: notes.trim() || null,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch (error) {
      console.error("Failed to save restaurant:", error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenWebsite = () => {
    if (website) {
      const url = website.startsWith("http") ? website : `https://${website}`;
      Linking.openURL(url);
    }
  };

  const handleOpenMaps = () => {
    const mapsUrl = Platform.select({
      ios: `maps:?q=${encodeURIComponent(name)}&ll=${restaurant.latitude},${restaurant.longitude}`,
      android: `geo:${restaurant.latitude},${restaurant.longitude}?q=${encodeURIComponent(name)}`,
      default: `https://www.google.com/maps/search/?api=1&query=${restaurant.latitude},${restaurant.longitude}`,
    });
    if (mapsUrl) {
      Linking.openURL(mapsUrl);
    }
  };

  return (
    <Modal visible={visible} animationType={"slide"} presentationStyle={"pageSheet"}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} className={"flex-1 bg-background"}>
        {/* Header */}
        <View className={"flex-row items-center justify-between p-4 border-b border-white/10"}>
          <Pressable onPress={onClose} hitSlop={12}>
            <ThemedText variant={"body"} className={"text-primary"}>
              Cancel
            </ThemedText>
          </Pressable>
          <ThemedText variant={"subhead"} className={"font-semibold"}>
            Edit Restaurant
          </ThemedText>
          <Pressable onPress={handleSave} hitSlop={12} disabled={isSaving || !name.trim()}>
            {isSaving ? (
              <ActivityIndicator size={"small"} />
            ) : (
              <ThemedText
                variant={"body"}
                className={`font-semibold ${name.trim() ? "text-primary" : "text-gray-500"}`}
              >
                Save
              </ThemedText>
            )}
          </Pressable>
        </View>

        <ScrollView
          className={"flex-1"}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          keyboardShouldPersistTaps={"handled"}
        >
          {!showGoogleSearch ? (
            <Animated.View entering={FadeIn} className={"gap-6"}>
              {/* Google Maps Import Button */}
              <Pressable
                onPress={() => {
                  setShowGoogleSearch(true);
                  setSearchQuery(restaurant.name);
                }}
              >
                <Card animated={false}>
                  <View className={"p-4 flex-row items-center gap-3"}>
                    <View className={"w-10 h-10 rounded-full bg-blue-500/20 items-center justify-center"}>
                      <IconSymbol name={"location.fill"} size={20} color={"#3b82f6"} />
                    </View>
                    <View className={"flex-1"}>
                      <ThemedText variant={"subhead"} className={"font-medium"}>
                        Import from Google Maps
                      </ThemedText>
                      <ThemedText variant={"footnote"} color={"tertiary"}>
                        Search and pull restaurant info
                      </ThemedText>
                    </View>
                    <IconSymbol name={"chevron.right"} size={16} color={"#6b7280"} />
                  </View>
                </Card>
              </Pressable>

              {/* Form Fields */}
              <View className={"gap-4"}>
                <InputField
                  label={"Name"}
                  value={name}
                  onChangeText={setName}
                  placeholder={"Restaurant name"}
                  autoCapitalize={"words"}
                />

                <InputField
                  label={"Address"}
                  value={address}
                  onChangeText={setAddress}
                  placeholder={"Street address"}
                  autoCapitalize={"words"}
                />

                <InputField
                  label={"Cuisine Type"}
                  value={cuisine}
                  onChangeText={setCuisine}
                  placeholder={"e.g., Italian, Japanese, French"}
                  autoCapitalize={"words"}
                />

                <PriceLevelSelector value={priceLevel} onChange={setPriceLevel} />

                <InputField
                  label={"Phone"}
                  value={phone}
                  onChangeText={setPhone}
                  placeholder={"+1 (555) 123-4567"}
                  keyboardType={"phone-pad"}
                />

                <View className={"gap-1.5"}>
                  <ThemedText variant={"footnote"} color={"secondary"} className={"font-medium"}>
                    Website
                  </ThemedText>
                  <View className={"flex-row gap-2"}>
                    <TextInput
                      value={website}
                      onChangeText={setWebsite}
                      placeholder={"https://..."}
                      placeholderTextColor={"#6b7280"}
                      keyboardType={"url"}
                      autoCapitalize={"none"}
                      autoCorrect={false}
                      className={"flex-1 bg-secondary rounded-lg px-4 py-3 text-foreground"}
                    />
                    {website.trim() && (
                      <Pressable
                        onPress={handleOpenWebsite}
                        className={"bg-secondary rounded-lg px-4 py-3 items-center justify-center"}
                      >
                        <IconSymbol name={"safari"} size={20} color={"#3b82f6"} />
                      </Pressable>
                    )}
                  </View>
                </View>

                <InputField
                  label={"Notes"}
                  value={notes}
                  onChangeText={setNotes}
                  placeholder={"Personal notes about this restaurant..."}
                  multiline
                />
              </View>

              {/* Quick Actions */}
              <View className={"gap-3 mt-2"}>
                <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide"}>
                  Quick Actions
                </ThemedText>
                <View className={"flex-row gap-3"}>
                  <Pressable
                    onPress={handleOpenMaps}
                    className={"flex-1 bg-secondary rounded-lg py-3 flex-row items-center justify-center gap-2"}
                  >
                    <IconSymbol name={"map"} size={18} color={"#6b7280"} />
                    <ThemedText variant={"footnote"} color={"secondary"}>
                      Open in Maps
                    </ThemedText>
                  </Pressable>
                  {phone && (
                    <Pressable
                      onPress={() => Linking.openURL(`tel:${phone}`)}
                      className={"flex-1 bg-secondary rounded-lg py-3 flex-row items-center justify-center gap-2"}
                    >
                      <IconSymbol name={"phone"} size={18} color={"#6b7280"} />
                      <ThemedText variant={"footnote"} color={"secondary"}>
                        Call
                      </ThemedText>
                    </Pressable>
                  )}
                </View>
              </View>
            </Animated.View>
          ) : (
            /* Google Search Mode */
            <Animated.View entering={FadeIn} className={"gap-4"}>
              <View className={"flex-row items-center gap-2"}>
                <Pressable
                  onPress={() => {
                    setShowGoogleSearch(false);
                    setSearchQuery("");
                  }}
                >
                  <IconSymbol name={"chevron.left"} size={20} color={"#6b7280"} />
                </Pressable>
                <ThemedText variant={"subhead"} color={"secondary"} className={"font-medium"}>
                  Search Google Maps
                </ThemedText>
              </View>

              <View className={"flex-row gap-2"}>
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder={"Search for restaurant..."}
                  placeholderTextColor={"#6b7280"}
                  autoCapitalize={"words"}
                  autoCorrect={false}
                  returnKeyType={"search"}
                  onSubmitEditing={handleSearch}
                  className={"flex-1 bg-secondary rounded-lg px-4 py-3 text-foreground"}
                />
                <Button onPress={handleSearch} variant={"secondary"} size={"icon"} loading={isSearching}>
                  <IconSymbol name={"magnifyingglass"} size={20} color={"#fff"} />
                </Button>
              </View>

              {searchResults.length > 0 && (
                <View className={"gap-3"}>
                  <ThemedText variant={"footnote"} color={"tertiary"}>
                    Select to import details
                  </ThemedText>
                  {searchResults.map((place) => (
                    <GooglePlaceSearchResult
                      key={place.placeId}
                      place={place}
                      onSelect={() => handleSelectPlace(place)}
                      isLoading={loadingPlaceId === place.placeId}
                    />
                  ))}
                </View>
              )}

              {!isSearching && searchResults.length === 0 && searchQuery && (
                <View className={"py-8 items-center"}>
                  <ThemedText variant={"body"} color={"tertiary"}>
                    Search for a restaurant to import details
                  </ThemedText>
                </View>
              )}
            </Animated.View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
