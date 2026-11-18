# Activate reader services

1. Deploy the Jekyll changes and open https://raymo200915.github.io/reader-posts.json to check that the published article list loads.
2. In the Google account that will send the emails, create a private Google Sheet. Open Extensions > Apps Script. Paste Code.gs into the script file and add an HTML file named Reader containing Reader.html.
3. Run setup_ from the script editor and authorize spreadsheet access, outbound HTTP, email and the hourly trigger. The spreadsheet now contains Comments, Likes and Subscribers tabs.
4. Choose Deploy > New deployment > Web app. Execute as yourself and grant access to Anyone, including signed-out visitors. Put the deployment URL ending in /exec in reader_app_url in _config.yml and deploy Pages again. For subsequent script changes, update the deployment to a new version.
5. Open Contact in a signed-out window, send a message and check raymondmaoca@gmail.com. Subscribe with a second mailbox and confirm through the email link. The hourly job emails each confirmed subscriber when a new article URL appears. Sending uses the Google account's Apps Script mail quota.
6. Like a post and submit a comment. In the private Comments sheet change its Status from pending to approved, then reload the article. Delete rejected rows or leave them pending. Keep the spreadsheet private.
