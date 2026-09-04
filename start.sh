docker stop derouter
docker rm derouter
docker build -t derouter .
docker run -d --name derouter -p 20128:20128 --env-file .env -v derouter-data:/app/data derouter
