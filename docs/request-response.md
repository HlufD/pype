# Express-Style Request & Response Methods Checklist

This is a checklist of methods and properties you can add to your custom `Request` and `Response` classes to mimic Express's `req` and `res` objects. You can edit and tick them as you implement.

## Response Methods

| Method                                       | Description                      | Implemented |
| -------------------------------------------- | -------------------------------- | ----------- |
| `status(code)`                               | Set HTTP status code             | [ ]         |
| `send(body)`                                 | Send string, buffer, or object   | [ ]         |
| `json(obj)`                                  | Send JSON response               | [ ]         |
| `jsonp(obj)`                                 | Send JSONP response              | [ ]         |
| `sendStatus(code)`                           | Send HTTP status with text       | [ ]         |
| `end([data])`                                | End response                     | [ ]         |
| `set(field, value)` / `header(field, value)` | Set HTTP header                  | [ ]         |
| `get(field)`                                 | Read response header             | [ ]         |
| `type(mime)`                                 | Set Content-Type header          | [ ]         |
| `location(url)`                              | Set Location header              | [ ]         |
| `links(linksObj)`                            | Set Link headers                 | [ ]         |
| `vary(field)`                                | Set Vary header                  | [ ]         |
| `append(field, value)`                       | Append header value              | [ ]         |
| `cookie(name, value, options)`               | Set cookie                       | [ ]         |
| `clearCookie(name, options)`                 | Clear cookie                     | [ ]         |
| `redirect([status,] url)`                    | Redirect response                | [ ]         |
| `format(obj)`                                | Respond based on Accept header   | [ ]         |
| `attachment([filename])`                     | Set Content-Disposition for file | [ ]         |
| `download(path, [filename], [callback])`     | Send file for download           | [ ]         |
| `charset(charset)`                           | Set response charset             | [ ]         |
| `getHeaderNames()`                           | Get all response headers         | [ ]         |

## Request Properties & Methods

| Property / Method    | Description                                  | Implemented |
| -------------------- | -------------------------------------------- | ----------- |
| `req.params`         | Route parameters                             | [ ]         |
| `req.query`          | URL query string parameters                  | [ ]         |
| `req.body`           | Parsed request body                          | [ ]         |
| `req.cookies`        | Parsed cookies                               | [ ]         |
| `req.signedCookies`  | Signed cookies                               | [ ]         |
| `req.headers`        | Request headers                              | [ ]         |
| `req.get(field)`     | Get specific header                          | [ ]         |
| `req.ip`             | Remote IP address                            | [ ]         |
| `req.ips`            | Array of IP addresses when behind proxy      | [ ]         |
| `req.path`           | Path part of URL                             | [ ]         |
| `req.hostname`       | Hostname of request                          | [ ]         |
| `req.protocol`       | Request protocol (http/https)                | [ ]         |
| `req.secure`         | True if request is HTTPS                     | [ ]         |
| `req.originalUrl`    | Original request URL                         | [ ]         |
| `req.method`         | HTTP method                                  | [ ]         |
| `req.is(type)`       | Check content type                           | [ ]         |
| `req.accepts(types)` | Check accepted content types                 | [ ]         |
| `req.get(field)`     | Get a header value                           | [ ]         |
| `req.range(size)`    | Parse Range header                           | [ ]         |
| `req.fresh`          | True if request is fresh                     | [ ]         |
| `req.stale`          | True if request is stale                     | [ ]         |
| `req.subdomains`     | Array of subdomains                          | [ ]         |
| `req.xhr`            | True if request was issued by XMLHttpRequest | [ ]         |
