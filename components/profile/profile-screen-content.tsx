import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, type Href } from "expo-router";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import React, { useState } from "react";
import { Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppleSignInButton } from "@/components/auth/apple-sign-in-button";
import { AuthTextField } from "@/components/auth/auth-text-field";
import { ThemedText } from "@/components/themed-text";
import { Button, ButtonText, Card } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { signOut, useSession } from "@/lib/auth-client";
import { cloudQueryKeys } from "@/lib/cloud-sync";
import { useTRPCClient } from "@/lib/trpc";

function CountTile({ label, value }: { label: string; value: number | undefined }) {
  return (
    <View className={"flex-1 rounded-2xl border border-white/10 bg-background px-3 py-3"}>
      <ThemedText variant={"title4"} className={"font-semibold"} selectable>
        {(value ?? 0).toLocaleString()}
      </ThemedText>
      <ThemedText variant={"caption1"} color={"tertiary"}>
        {label}
      </ThemedText>
    </View>
  );
}

interface ProfileDraft {
  bio: string;
  homeCity: string;
  favoriteCuisine: string;
  publicVisits: boolean;
}

function getProfileDraft(
  profile:
    | {
        bio?: string | null;
        homeCity?: string | null;
        favoriteCuisine?: string | null;
        publicVisits?: boolean | null;
      }
    | null
    | undefined,
): ProfileDraft {
  return {
    bio: profile?.bio ?? "",
    homeCity: profile?.homeCity ?? "",
    favoriteCuisine: profile?.favoriteCuisine ?? "",
    publicVisits: profile?.publicVisits ?? false,
  };
}

interface ProfileScreenContentProps {
  showSettingsButton?: boolean;
}

export function ProfileScreenContent({ showSettingsButton = false }: ProfileScreenContentProps) {
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const trpcClient = useTRPCClient();
  const { data: session } = useSession();
  const [draft, setDraft] = useState<ProfileDraft | null>(null);

  const profileQuery = useQuery({
    queryKey: cloudQueryKeys.profile,
    enabled: Boolean(session?.user),
    queryFn: () => trpcClient.profile.me.query(),
  });

  const profile = profileQuery.data?.profile;
  const savedDraft = getProfileDraft(profile);
  const activeDraft = session?.user ? (draft ?? savedDraft) : null;
  const bio = activeDraft?.bio ?? "";
  const homeCity = activeDraft?.homeCity ?? profile?.homeCity ?? "";
  const favoriteCuisine = activeDraft?.favoriteCuisine ?? profile?.favoriteCuisine ?? "";
  const publicVisits = activeDraft?.publicVisits ?? profile?.publicVisits ?? false;
  const hasProfileChanges =
    draft !== null &&
    (draft.bio !== savedDraft.bio ||
      draft.homeCity !== savedDraft.homeCity ||
      draft.favoriteCuisine !== savedDraft.favoriteCuisine ||
      draft.publicVisits !== savedDraft.publicVisits);

  const updateProfileMutation = useMutation({
    mutationFn: async () => {
      if (!session?.user) {
        throw new Error("Sign in to save your cloud profile.");
      }

      return trpcClient.profile.update.mutate({
        bio: bio.trim() || null,
        homeCity: homeCity.trim() || null,
        favoriteCuisine: favoriteCuisine.trim() || null,
        publicVisits,
      });
    },
    onSuccess: (updatedProfile) => {
      queryClient.setQueryData(
        cloudQueryKeys.profile,
        (current: Awaited<ReturnType<typeof trpcClient.profile.me.query>> | undefined) =>
          current
            ? {
                ...current,
                profile: updatedProfile,
              }
            : current,
      );
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ["cloud", "social"] });
      showToast({ type: "success", message: "Cloud profile updated." });
    },
    onError: (error) => {
      showToast({ type: "error", message: error.message || "Failed to save your profile" });
    },
  });

  async function handleSignOut() {
    const result = await signOut();

    if (result.error) {
      showToast({ type: "error", message: result.error.message ?? "Unable to sign out" });
      return;
    }

    queryClient.removeQueries({ queryKey: ["cloud"] });
    setDraft(null);
    router.replace("/settings" as Href);
  }

  const counts = profileQuery.data?.counts;

  return (
    <ScrollView
      className={"flex-1 bg-background"}
      contentInsetAdjustmentBehavior={"automatic"}
      contentContainerStyle={{
        paddingTop: 12,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 16,
        gap: 16,
      }}
      keyboardShouldPersistTaps={"handled"}
    >
      <View className={"mb-1 flex-row items-start justify-between gap-4"}>
        <View className={"flex-1 gap-2"}>
          <ThemedText variant={"largeTitle"} className={"font-bold"}>
            Profile
          </ThemedText>
          <ThemedText variant={"body"} color={"secondary"}>
            Show people what you are into, keep your details fresh, and jump into your social circle.
          </ThemedText>
        </View>

        {showSettingsButton ? (
          <Pressable
            onPress={() => router.push("/preferences" as Href)}
            className={"mt-1 h-10 w-10 items-center justify-center rounded-full bg-secondary/70"}
            hitSlop={8}
          >
            <MaterialIcons name={"settings"} size={20} color={"#8E8E93"} />
          </Pressable>
        ) : null}
      </View>

      <Card animated={false} className={"gap-4 p-5"}>
        <View className={"flex-row items-start gap-4"}>
          <View className={"h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-primary/15"}>
            <ThemedText variant={"title2"} className={"font-bold text-primary"}>
              {session?.user?.name?.trim().charAt(0).toUpperCase() || "P"}
            </ThemedText>
          </View>
          <View className={"flex-1 gap-1"}>
            <ThemedText variant={"title2"} className={"font-bold"}>
              {session?.user?.name || "Your Palate profile"}
            </ThemedText>
            <ThemedText variant={"body"} color={"secondary"} selectable>
              {session?.user?.email ?? "Use Palate without an account, then sign in later for sync and social."}
            </ThemedText>
            {session?.user ? (
              <ThemedText variant={"footnote"} color={"tertiary"}>
                {bio.trim() || "Add a short bio so friends can get a feel for your food personality."}
              </ThemedText>
            ) : (
              <ThemedText variant={"footnote"} color={"tertiary"}>
                Create a profile when you are ready to sync visits, follow friends, and share your taste.
              </ThemedText>
            )}
          </View>
        </View>

        {session?.user ? (
          <>
            <View className={"flex-row gap-3"}>
              <CountTile label={"Friends"} value={counts?.friends} />
              <CountTile label={"Followers"} value={counts?.followers} />
            </View>

            <View className={"flex-row gap-3"}>
              <CountTile label={"Following"} value={counts?.following} />
              <CountTile label={"Visits"} value={counts?.syncedVisits} />
            </View>

            <Button variant={"secondary"} onPress={() => router.push("/social" as Href)}>
              <ButtonText variant={"secondary"}>Friends & Following</ButtonText>
            </Button>
          </>
        ) : (
          <AppleSignInButton />
        )}
      </Card>

      {session?.user ? (
        <>
          <Card animated={false} className={"gap-4 p-5"}>
            <View className={"gap-1"}>
              <ThemedText variant={"title4"} className={"font-semibold"}>
                Profile details
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Share the basics people should see when they open your Palate profile.
              </ThemedText>
            </View>

            <View className={"gap-2"}>
              <View className={"flex-row items-center justify-between gap-3"}>
                <ThemedText variant={"subhead"} className={"font-semibold"}>
                  Bio
                </ThemedText>
                <ThemedText variant={"caption1"} color={"tertiary"}>
                  280 characters
                </ThemedText>
              </View>
              <TextInput
                value={bio}
                onChangeText={(value) =>
                  setDraft((current) => ({
                    ...(current ?? getProfileDraft(profile)),
                    bio: value,
                  }))
                }
                placeholder={"Neighborhood pasta obsessive. Always saving room for dessert."}
                placeholderTextColor={"rgba(255,255,255,0.42)"}
                multiline
                maxLength={280}
                textAlignVertical={"top"}
                className={
                  "min-h-[112px] rounded-2xl border border-white/10 bg-background px-4 py-3 text-[16px] text-foreground"
                }
                autoCorrect
              />
            </View>

            <AuthTextField
              label={"Home city"}
              value={homeCity}
              onChangeText={(value) =>
                setDraft((current) => ({
                  ...(current ?? getProfileDraft(profile)),
                  homeCity: value,
                }))
              }
              placeholder={"San Francisco"}
            />
            <AuthTextField
              label={"Favorite cuisine"}
              value={favoriteCuisine}
              onChangeText={(value) =>
                setDraft((current) => ({
                  ...(current ?? getProfileDraft(profile)),
                  favoriteCuisine: value,
                }))
              }
              placeholder={"Japanese"}
            />

            <View className={"rounded-2xl border border-white/10 bg-background px-4 py-3"}>
              <View className={"flex-row items-start justify-between gap-4"}>
                <View className={"flex-1 gap-1"}>
                  <ThemedText variant={"subhead"} className={"font-semibold"}>
                    Public visit history
                  </ThemedText>
                  <ThemedText variant={"footnote"} color={"secondary"}>
                    Let anyone who opens your profile see your confirmed visits. Followers can already see them.
                  </ThemedText>
                </View>

                <Switch
                  value={publicVisits}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...(current ?? getProfileDraft(profile)),
                      publicVisits: value,
                    }))
                  }
                />
              </View>
            </View>

            {profileQuery.error ? (
              <ThemedText
                variant={"footnote"}
                className={"rounded-2xl bg-red-500/10 px-3 py-2 text-red-300"}
                selectable
              >
                {profileQuery.error.message}
              </ThemedText>
            ) : null}

            <Button
              onPress={() => updateProfileMutation.mutate()}
              loading={updateProfileMutation.isPending}
              disabled={!hasProfileChanges}
            >
              <ButtonText>Save Profile</ButtonText>
            </Button>
          </Card>

          <Card animated={false} className={"gap-4 p-5"}>
            <View className={"gap-1"}>
              <ThemedText variant={"title4"} className={"font-semibold"}>
                Account
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Signed in with Apple. You can stay local-first until you are ready to come back.
              </ThemedText>
            </View>

            <View className={"rounded-2xl border border-white/10 bg-background px-4 py-3"}>
              <ThemedText variant={"subhead"} className={"font-semibold"}>
                {session.user.email}
              </ThemedText>
              <ThemedText variant={"footnote"} color={"secondary"}>
                Sign out from the bottom of your profile whenever you want to stop syncing with this account.
              </ThemedText>
            </View>

            <Button variant={"secondary"} onPress={handleSignOut}>
              <ButtonText variant={"secondary"}>Sign Out</ButtonText>
            </Button>
          </Card>
        </>
      ) : (
        <Card animated={false} className={"gap-3 p-5"}>
          <ThemedText variant={"title4"} className={"font-semibold"}>
            Optional cloud profile
          </ThemedText>
          <ThemedText variant={"footnote"} color={"secondary"}>
            Signing in is still optional. When you want cloud sync, a public profile, or following, continue with Apple.
          </ThemedText>
        </Card>
      )}
    </ScrollView>
  );
}
