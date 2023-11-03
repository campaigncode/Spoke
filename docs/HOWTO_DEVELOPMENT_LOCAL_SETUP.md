## Getting started

---

### [Repository](https://github.com/MoveOnOrg/Spoke)

1. If you have not already, Fork this repo then clone your forked copy. Then future pull requests can be made from your repo to Spoke.

```
git clone https://github.com/campaigncode/Spoke
```

2. change your pwd (present working directory) to the spoke directory before installations

```
cd Spoke
```

### Downloading Node

1. Install the Node version listed in `.nvmrc`. This can also be found here:[.nvmrc](https://github.com/MoveOnOrg/Spoke/blob/main/.nvmrc).
   From the spoke directory:

   - run

   ```
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash
   ```

   ```
   nvm install node
   nvm use node
   ```

2. Install yarn.

   ```
   corepack enable
   ```

3. Install the packages.
   ```
   yarn install
   ```
4. Create a real environment file:
   ```
   cp .env.example .env
   ```

- This creates a copy of `.env.example`, but renames it `.env` so the system will use it. _Make sure you use this new file._

---

### Your `.env` file

We use environment variables to allow instance admins to customize their Spoke experience. If you end up doing dev work on an area that is configured through environment variables, it will be helpful to be familiar with the patterns used. Because of this, we recommend that you take a look at the [environment variable reference](REFERENCE-environment_variables.md) to get a lay of the land.

Make sure environment variable `JOBS_SAME_PROCESS=1` is set.
Make sure `SUPPRESS_SELF_INVITE=` is NOT set.
Set `DEFAULT_SERVICE=fakeservice`.

---

### Getting the app running

At this point, you should be ready to start your app in development mode.

1. Run `yarn dev` to create and populate the tables.
   - Wait until you see both "Node app is running ..." and "webpack: Compiled successfully." before attempting to connect. ()
2. Go to `http://localhost:3000` to load the app. (Note: the terminal will say it's running on port 8090 -- don't believe it :-)
3. You should then be prompted to create an organization. Create it.
4. **Once you've created your organization, set the env var `SUPPRESS_SELF_INVITE=1` so you don't get prompted to create a new org every time you log in**
5. See the [Admin](https://youtu.be/PTMykMX8gII) and [Texter](https://youtu.be/EqE1UDvKGco) demos to learn about how Spoke works.
6. See [the development guidelines](EXPLANATION-development-guidelines.md)
7. See [How to Run Tests](HOWTO-run_tests.md)

### SMS and Twilio in development

For development, you can set `DEFAULT_SERVICE=fakeservice` to skip using an SMS provider (Twilio or Nexmo) and insert the message directly into the database.

To simulate receiving a reply from a contact you can use the Send Replies utility: `http://localhost:3000/admin/1/campaigns/1/send-replies`, updating the app and campaign IDs as necessary. You can also include "autorespond" in the script message text, and an automatic reply will be generated (just for `fakeservice`!)

If you need to use Twilio in development but with live keys, click [here](HOWTO_INTEGRATE_TWILIO.md) for instructions.
When using instructions, please remember that references to NGROK urls should change to your Heroku app url.

### ngrok (Optional for testing)

If you want to test sending and receiving text messages with a real SMS provider in your local development environment, use [ngrok](https://ngrok.com/) to allow the vendor to communicate with Spoke.

1. Create an ngrok account and download ngrok.
2. Start up your Spoke dev env.
3. Open a new terminal and cd to where you downloaded ngrok.
4. Run the following command: `./ngrok http 3000`. You will see an external-facing app URL. Set the `BASE_URL` environment variable to that value. If you are using Auth0 for authentication, you will also need to log into Auth0 and update the Application URIs with the ngrok external-facing app URL.
