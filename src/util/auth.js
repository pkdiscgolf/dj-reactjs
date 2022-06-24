import React, {
  useState,
  useEffect,
  useMemo,
  useContext,
  createContext,
} from "react";
import auth0 from "./auth0";
import {
  getAuth,
  onAuthStateChanged,
  signOut as authSignOut,
  signInWithCustomToken,
} from "firebase/auth";
import { firebaseApp } from "./firebase";
import { useUser, createUser, updateUser } from "./db";
import { apiRequest, CustomError } from "./util";
import { history } from "./router";
import PageLoader from "./../components/PageLoader";
import { getFriendlyPlanId } from "./prices";
import analytics from "./analytics";

// Whether to merge extra user data from database into `auth.user`
const MERGE_DB_USER = true;

// Whether to connect analytics session to `user.uid`
const ANALYTICS_IDENTIFY = true;

// Initialize Firebase auth (required to read/write to Firestore)
const auth = getAuth(firebaseApp);

// Create a `useAuth` hook and `AuthProvider` that enables
// any component to subscribe to auth and re-render when it changes.
const authContext = createContext();
export const useAuth = () => useContext(authContext);
// This should wrap the app in `src/pages/_app.js`
export function AuthProvider({ children }) {
  const auth = useAuthProvider();
  return <authContext.Provider value={auth}>{children}</authContext.Provider>;
}

// Hook that creates the `auth` object and handles state
// This is called from `AuthProvider` above (extracted out for readability)
function useAuthProvider() {
  // Store auth user in state
  // `user` will be object, `null` (loading) or `false` (logged out)
  const [user, setUser] = useState(null);

  // Merge extra user data from the database
  // This means extra user data (such as payment plan) is available as part
  // of `auth.user` and doesn't need to be fetched separately. Convenient!
  let finalUser = useMergeExtraData(user, { enabled: MERGE_DB_USER });

  // Add custom fields and formatting to the `user` object
  finalUser = useFormatUser(finalUser);

  // Connect analytics session to user
  useIdentifyUser(finalUser, { enabled: ANALYTICS_IDENTIFY });

  // Handle response from auth functions (`signup`, `signin`, and `signinWithProvider`)
  const handleAuth = async (user) => {
    // Ensure Firebase user is ready before we continue
    // We exchange an Auth0 token for Firebase token in `auth0.extended.onChange`
    // so that we can make authenticated requests to Firestore.
    await waitForFirebase(user.sub);

    // Create the user in the database
    // Auth0 doesn't indicate if they are new so we attempt to create user every time
    await createUser(user.sub, { email: user.email });

    // Update user in state
    setUser(user);
    return user;
  };

  const signup = (email, password) => {
    return auth0.extended
      .signupAndAuthorize({
        email: email,
        password: password,
      })
      .then(handleAuth);
  };

  const signin = (email, password) => {
    return auth0.extended
      .login({
        username: email,
        password: password,
      })
      .then(handleAuth);
  };

  const signinWithProvider = (name) => {
    // Get current domain
    const domain =
      window.location.protocol +
      "//" +
      window.location.hostname +
      (window.location.port ? ":" + window.location.port : "");

    const providerId = authProviders.find((p) => p.name === name).id;

    return auth0.extended
      .popupAuthorize({
        redirectUri: `${domain}/auth0-callback`,
        connection: providerId,
      })
      .then(handleAuth);
  };

  const signout = () => {
    // Remove custom Firebase token we set for writing to Firestore
    authSignOut(auth);

    return auth0.extended.logout();
  };

  const sendPasswordResetEmail = (email) => {
    return auth0.extended.changePassword({
      email: email,
    });
  };

  const confirmPasswordReset = (password, code) => {
    // This method is not needed with Auth0 but added in case your exported
    // Divjoy template makes a call to auth.confirmPasswordReset(). You can remove it.
    return Promise.reject(
      new CustomError(
        "not_needed",
        "Auth0 handles the password reset flow for you. You can remove this section or page."
      )
    );
  };

  const updatePassword = (password) => {
    return auth0.extended.updatePassword(password);
  };

  // Update auth user and persist data to database
  // Call this function instead of multiple auth/db update functions
  const updateProfile = async (data) => {
    const { email, name, picture } = data;

    // Update auth email
    if (email) {
      await auth0.extended.updateEmail(email);
    }

    // Update built-in auth profile fields
    // These fields are renamed in `useFormatUser`, so when updating we
    // need to make sure to use their original names (`name`, `picture`, etc)
    if (name || picture) {
      let fields = {};
      if (name) fields.name = name;
      if (picture) fields.picture = picture;
      await auth0.extended.updateProfile(fields);
    }

    // Persist all data to the database
    await updateUser(user.sub, data);

    // Update user in state
    const currentUser = await auth0.extended.getCurrentUser();
    setUser(currentUser);
  };

  useEffect(() => {
    // Subscribe to user on mount
    const unsubscribe = auth0.extended.onChange(async (user) => {
      if (user) {
        // Authenticate with Firebase so we can read/write to Firestore
        await setFirebaseToken();
        await waitForFirebase(user.sub);

        setUser(user);
      } else {
        setUser(false);
      }
    });

    // Unsubscribe on cleanup
    return () => unsubscribe();
  }, []);

  return {
    user: finalUser,
    signup,
    signin,
    signinWithProvider,
    signout,
    sendPasswordResetEmail,
    confirmPasswordReset,
    updatePassword,
    updateProfile,
  };
}

function useFormatUser(user) {
  // Memoize so returned object has a stable identity
  return useMemo(() => {
    // Return if auth user is `null` (loading) or `false` (not authenticated)
    if (!user) return user;

    // Get the provider which is prepended to user.sub
    const providerId = user.sub.split("|")[0];
    // Create an array of user's auth providers by id, such as ["password"]
    // Components can read this to prompt user to re-auth with the correct provider
    // In the future this may contain multiple if Auth0 Account Linking is implemented.
    const providerName = authProviders.find((p) => p.id === providerId).name;
    const providers = [providerName];

    return {
      // Include full auth user data
      ...user,
      // Alter the names of some fields
      uid: user.sub,
      emailVerified: user.email_verified,
      // User's auth providers
      providers: providers,

      // Add `planId` (starter, pro, etc) based on Stripe Price ID
      ...(user.stripePriceId && {
        planId: getFriendlyPlanId(user.stripePriceId),
      }),
      // Add `planIsActive: true` if subscription status is active or trialing
      planIsActive: ["active", "trialing"].includes(
        user.stripeSubscriptionStatus
      ),
    };
  }, [user]);
}

function useMergeExtraData(user, { enabled }) {
  // Get extra user data from database
  const { data, status, error } = useUser(enabled && user && user.sub);

  // Memoize so returned object has a stable identity
  return useMemo(() => {
    // If disabled or no auth user (yet) then just return
    if (!enabled || !user) return user;

    switch (status) {
      case "success":
        // If successful, but `data` is `null`, that means user just signed up and the `createUser`
        // function hasn't populated the db yet. Return `null` to indicate auth is still loading.
        // The above call to `useUser` will re-render things once the data comes in.
        if (data === null) return null;
        // Return auth `user` merged with extra user `data`
        return { ...user, ...data };
      case "error":
        // Uh oh.. Let's at least show a helpful error.
        throw new Error(`
          Error: ${error.message}
          This happened while attempting to fetch extra user data from the database
          to include with the authenticated user. Make sure the database is setup or
          disable merging extra user data by setting MERGE_DB_USER to false.
        `);
      default:
        // We have an `idle` or `loading` status so return `null`
        // to indicate that auth is still loading.
        return null;
    }
  }, [user, enabled, data, status, error]);
}

// Connect analytics session to current user
function useIdentifyUser(user, { enabled }) {
  useEffect(() => {
    if (user && enabled) {
      analytics.identify(user.uid);
    }
  }, [user, enabled]);
}

// A Higher Order Component for requiring authentication
export const requireAuth = (Component) => {
  return (props) => {
    // Get authenticated user
    const auth = useAuth();

    useEffect(() => {
      // Redirect if not signed in
      if (auth.user === false) {
        history.replace("/auth/signin");
      }
    }, [auth]);

    // Show loading indicator
    // We're either loading (user is `null`) or about to redirect from above `useEffect` (user is `false`)
    if (!auth.user) {
      return <PageLoader />;
    }

    // Render component now that we have user
    return <Component {...props} />;
  };
};

const authProviders = [
  {
    id: "auth0",
    name: "password",
  },
  {
    id: "google-oauth2",
    name: "google",
  },
  {
    id: "facebook",
    name: "facebook",
  },
  {
    id: "twitter",
    name: "twitter",
  },
  {
    id: "github",
    name: "github",
  },
];

// Sign-in with a custom Firebase auth token
function setFirebaseToken() {
  return apiRequest("auth-firebase-token").then((token) => {
    return signInWithCustomToken(auth, token);
  });
}

// Wait for Firebase user to be initialized before resolving promise
// and taking any further action (such as writing to the database)
const waitForFirebase = (uid) => {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      // Ensure we have a user with expected `uid`
      if (user && user.uid === uid) {
        resolve(user); // Resolve promise
        unsubscribe(); // Prevent from firing again
      }
    });
  });
};
