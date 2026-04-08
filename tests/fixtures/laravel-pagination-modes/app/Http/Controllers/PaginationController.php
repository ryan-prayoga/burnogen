<?php

namespace App\Http\Controllers;

use App\Http\Resources\ProjectAutoCollection;
use App\Http\Resources\ProjectMethodCollection;
use App\Http\Resources\ProjectCollection;
use App\Http\Resources\ProjectResource;
use App\Http\Resources\ProjectWrappedCollection;

class PaginationController
{
    public function simple()
    {
        $page = request()->query('page');

        return ProjectResource::collection(
            Project::query()->simplePaginate(10, ['*'], 'page', $page)
        );
    }

    public function cursor()
    {
        $cursor = request()->query('cursor');

        return ProjectResource::collection(
            Project::query()->cursorPaginate(5, ['*'], 'cursor', $cursor)
        );
    }

    public function merged()
    {
        $page = request()->query('page');

        return ProjectResource::collection(
            Project::query()->paginate(20, ['*'], 'page', $page)
        )->additional([
            'meta' => [
                'source' => 'manual',
                'per_page' => 99,
            ],
            'links' => [
                'next' => 'https://example.test/projects?page=2',
                'docs' => 'https://example.test/docs/pagination',
            ],
        ]);
    }

    public function collectionClass()
    {
        $page = request()->query('page');

        return new ProjectCollection(
            Project::query()->paginate(12, ['*'], 'page', $page)
        );
    }

    public function collectionAuto()
    {
        $page = request()->query('page');

        return new ProjectAutoCollection(
            Project::query()->paginate(8, ['*'], 'page', $page)
        );
    }

    public function collectionMethod()
    {
        $page = request()->query('page');

        return new ProjectMethodCollection(
            Project::query()->paginate(6, ['*'], 'page', $page)
        );
    }

    public function collectionWrapped()
    {
        $page = request()->query('page');

        return new ProjectWrappedCollection(
            Project::query()->paginate(4, ['*'], 'page', $page)
        );
    }
}
