import type { OnboardingSlide } from "./types";
import { AuthStepContent } from "./auth-step";
import { CalendarSelectionContent } from "./calendar-selection";

export const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    id: "1",
    icon: "camera.viewfinder",
    iconColor: "#f97316",
    iconBg: "bg-orange-500/20",
    title: "Welcome to\nPalate",
    subtitle: "Your dining journal, automated",
    description:
      "We scan your photos and calendar events to find restaurant visits and create a beautiful log of your culinary adventures.",
    gradient: ["#0f0f23", "#1a1a2e", "#1e1e3f", "#0f1f4a"],
  },
  {
    id: "2",
    icon: "photo.stack",
    iconColor: "#22c55e",
    iconBg: "bg-green-500/20",
    title: "Access Your\nPhotos",
    subtitle: "Privacy-first scanning",
    description:
      "We need access to your photo library to find restaurant visits. Your photos never leave your device—all analysis happens locally.",
    gradient: ["#0f1a17", "#0f2a1f", "#0f3d2a", "#0a4d35"],
    permission: "photos",
  },
  {
    id: "3",
    icon: "calendar",
    iconColor: "#3b82f6",
    iconBg: "bg-blue-500/20",
    title: "Connect Your\nCalendar",
    subtitle: "Optional but recommended",
    description:
      "Calendar access helps us match your photos with restaurant reservations for more accurate visit detection.",
    gradient: ["#0f1723", "#0f2a3e", "#0f3d55", "#0a4d6a"],
    permission: "calendar",
  },
  {
    id: "4",
    icon: "checklist",
    iconColor: "#06b6d4",
    iconBg: "bg-cyan-500/20",
    title: "Choose Your\nCalendars",
    subtitle: "Select which to sync",
    description: "",
    gradient: ["#0f1a23", "#0f2a3e", "#0a3d4d", "#064d5a"],
    CustomContent: CalendarSelectionContent,
    buttonText: "Continue",
  },
  {
    id: "5",
    icon: "fork.knife",
    iconColor: "#8b5cf6",
    iconBg: "bg-purple-500/20",
    title: "Review Your\nVisits",
    subtitle: "Confirm and organize",
    description:
      "Review detected visits, confirm the restaurant, and build your personal dining history with photos and memories.",
    gradient: ["#1a0f23", "#2a1a3e", "#3d1f55", "#4d0a6a"],
  },
  {
    id: "6",
    icon: "person.crop.circle.badge.checkmark",
    iconColor: "#f59e0b",
    iconBg: "bg-amber-500/20",
    title: "Add Apple\nSign-In",
    subtitle: "Optional cloud sync",
    description:
      "Keep using Palate fully offline, or connect Apple now to sync confirmed visits, control public profile visibility, and follow friends.",
    gradient: ["#22160f", "#3a2414", "#4d3118", "#6d4417"],
    CustomContent: AuthStepContent,
  },
  {
    id: "7",
    icon: "chart.bar.fill",
    iconColor: "#eab308",
    iconBg: "bg-yellow-500/20",
    title: "Track Your\nJourney",
    subtitle: "Discover your dining habits",
    description:
      "See your favorite spots, Michelin experiences, cuisine preferences, and get a yearly wrapped of your foodie adventures.",
    gradient: ["#231f0f", "#3e3a1a", "#55501f", "#6a650a"],
  },
];
