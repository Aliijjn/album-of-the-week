Create a discord bot that picks an album for a server to listen to each week

The selection should go like this:
- Users can add an album (name + artist name), which will be stored in a DB (max 5 per user)
- Once every week on Sunday at 12:00 GMT (should be customisable), the bot will pick one album to be listened to by each user
- It should first pick a user, then one of their albums, so users with more albums don't have a higher chance to be picked
- The selection should be done in a way where it's random, but all users should be picked once before picking someone for a second time (with some nuance for users that joined later)
- When an album is announced, it should ping the tag album-of-the-week (should be customisable)
- The data should be separated per server

Stack:
- TS + Express (can be a different framework)
- SQLite
- NPM
- To be deployed to the cloud eventually