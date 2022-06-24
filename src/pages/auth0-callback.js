import React, { useLayoutEffect } from "react";
import Meta from "./../components/Meta";
import auth0 from "./../util/auth0";

function Auth0CallbackPage(props) {
  useLayoutEffect(() => {
    // Hide body so layout components are not visible
    document.body.style.display = "none";
    // Get auth results and close popup
    auth0.popup.callback();
  }, []);

  return <Meta title="Auth0 Callback" />;
}

export default Auth0CallbackPage;
