import http from "http";

const server = http.createServer((req, res) => {
    res.end("Server is working 🚀");
});

server.listen(3000, () => {
    console.log("Listening on port 3000");
});
