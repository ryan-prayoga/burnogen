<?php

namespace App\Http\Controllers;

use App\Http\Resources\ProjectResource;

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
}
